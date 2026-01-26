# QEMU 外设建模流程

我们以 PL011 串口为例，说明 QEMU 外设建模的主要方法。选择 PL011 作为讲解对象的原因是，这个设备同样实现了 Rust 版本，方便大家学习，同时，PL011 也是我们专业阶段实验 G233 主板所使用的串口设备。

PL011 的实现位于 `hw/char/pl011.c`，状态定义在 `include/hw/char/pl011.h`。它是一个典型的 SysBus 设备：通过 QOM 注册类型、用状态结构描述寄存器与 FIFO、用 MMIO 回调响应访问、并通过 IRQ 线连接到平台中断控制器（如 GIC）。

!!! tip "概览"

    - QOM 注册类型，并定义变体
    - 状态结构覆盖寄存器、FIFO、IRQ、时钟
    - instance_init 配置 MMIO/IRQ/时钟
    - realize 绑定 chardev 回调
    - MMIO 读写驱动寄存器与 FIFO
    - 机型侧完成地址映射与中断连接

## 类型注册

PL011 有两个 TypeInfo：标准 ARM 版本与 Luminary 变体。注册在模块初始化时完成：

```c
/* hw/char/pl011.c */
static const TypeInfo pl011_arm_info = {
    .name          = TYPE_PL011,
    .parent        = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(PL011State),
    .instance_init = pl011_init,
    .class_init    = pl011_class_init,
};

static const TypeInfo pl011_luminary_info = {
    .name          = TYPE_PL011_LUMINARY,
    .parent        = TYPE_PL011,
    .instance_init = pl011_luminary_init,
};

static void pl011_register_types(void)
{
    type_register_static(&pl011_arm_info);
    type_register_static(&pl011_luminary_info);
}

type_init(pl011_register_types)
```

## 状态结构

PL011State 记录寄存器、FIFO、IRQ 与时钟等核心状态（节选）：

```c
/* include/hw/char/pl011.h */
struct PL011State {
    SysBusDevice parent_obj;

    MemoryRegion iomem;
    uint32_t flags;
    uint32_t lcr;
    uint32_t cr;
    uint32_t int_enabled;
    uint32_t int_level;
    uint32_t read_fifo[PL011_FIFO_DEPTH];
    int read_pos;
    int read_count;
    int read_trigger;
    CharFrontend chr;
    qemu_irq irq[6];
    Clock *clk;
    bool migrate_clk;
    const unsigned char *id;
};
```

这里有几个关键点：

- `irq[6]` 表示组合中断线与细分中断线都被建模。
- `read_fifo` 与 `read_*` 字段驱动 RX FIFO 的状态机。
- `clk` + `migrate_clk` 用于时钟输入与迁移控制。

## 实例初始化

instance_init 阶段完成 MMIO/IRQ/时钟的基础连线：

```c
/* hw/char/pl011.c */
static void pl011_init(Object *obj)
{
    SysBusDevice *sbd = SYS_BUS_DEVICE(obj);
    PL011State *s = PL011(obj);
    int i;

    memory_region_init_io(&s->iomem, OBJECT(s), &pl011_ops, s, "pl011", 0x1000);
    sysbus_init_mmio(sbd, &s->iomem);
    for (i = 0; i < ARRAY_SIZE(s->irq); i++) {
        sysbus_init_irq(sbd, &s->irq[i]);
    }

    s->clk = qdev_init_clock_in(DEVICE(obj), "clk", pl011_clock_update, s,
                                ClockUpdate);
    s->id = pl011_id_arm;
}
```

## 类初始化

类初始化负责绑定 realize/reset/vmstate，并暴露属性：

```c
/* hw/char/pl011.c */
static const Property pl011_properties[] = {
    DEFINE_PROP_CHR("chardev", PL011State, chr),
    DEFINE_PROP_BOOL("migrate-clk", PL011State, migrate_clk, true),
};

static void pl011_class_init(ObjectClass *oc, const void *data)
{
    DeviceClass *dc = DEVICE_CLASS(oc);

    dc->realize = pl011_realize;
    device_class_set_legacy_reset(dc, pl011_reset);
    dc->vmsd = &vmstate_pl011;
    device_class_set_props(dc, pl011_properties);
}
```

`chardev` 决定串口后端（终端、文件、socket），`migrate-clk` 控制时钟是否参与迁移。

## MMIO 逻辑

PL011 通过 MemoryRegionOps 暴露寄存器读写入口：

```c
/* hw/char/pl011.c */
static const MemoryRegionOps pl011_ops = {
    .read = pl011_read,
    .write = pl011_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .impl.min_access_size = 4,
    .impl.max_access_size = 4,
};
```

`pl011_read/pl011_write` 解析寄存器偏移，更新 flags、FIFO 与中断状态。

## FIFO 与中断

### FIFO 深度

FIFO 深度受 `LCR_FEN` 控制，未开启时退化为单字节缓冲：

```c
/* hw/char/pl011.c */
static inline unsigned pl011_get_fifo_depth(PL011State *s)
{
    return pl011_is_fifo_enabled(s) ? PL011_FIFO_DEPTH : 1;
}
```

### 中断线

PL011 维护 `int_level` 与 `int_enabled`，并通过掩码把不同原因映射到多条 IRQ 线上：

```c
/* hw/char/pl011.c */
static const uint32_t irqmask[] = {
    INT_E | INT_MS | INT_RT | INT_TX | INT_RX, /* combined */
    INT_RX,
    INT_TX,
    INT_RT,
    INT_MS,
    INT_E,
};

static void pl011_update(PL011State *s)
{
    uint32_t flags;
    int i;

    flags = s->int_level & s->int_enabled;
    for (i = 0; i < ARRAY_SIZE(s->irq); i++) {
        qemu_set_irq(s->irq[i], (flags & irqmask[i]) != 0);
    }
}
```

这也是 PL011 比“简单 UART”更复杂的地方：它不仅有 RX/TX 中断，还建模了错误与调制解调器状态中断。

## 机型集成

在 ARM virt 机型中，PL011 的集成在 `hw/arm/virt.c` 里完成（节选）：

```c
/* hw/arm/virt.c */
DeviceState *dev = qdev_new(TYPE_PL011);
SysBusDevice *s = SYS_BUS_DEVICE(dev);

qdev_prop_set_chr(dev, "chardev", chr);
sysbus_realize_and_unref(s, &error_fatal);
memory_region_add_subregion(mem, base, sysbus_mmio_get_region(s, 0));
sysbus_connect_irq(s, 0, qdev_get_gpio_in(vms->gic, irq));
```

除此之外，virt 还会把 PL011 节点写入设备树（compatible、reg、interrupts、clock-names），并设置 `stdout-path`，让客户机把它作为默认串口。

## 迁移时钟

PL011 支持迁移，状态由 `vmstate_pl011` 描述，并可选迁移时钟：

```c
/* hw/char/pl011.c */
static const VMStateDescription vmstate_pl011_clock = {
    .name = "pl011/clock",
    .version_id = 1,
    .minimum_version_id = 1,
    .needed = pl011_clock_needed,
    .fields = (const VMStateField[]) {
        VMSTATE_CLOCK(clk, PL011State),
        VMSTATE_END_OF_LIST()
    }
};

static const VMStateDescription vmstate_pl011 = {
    .name = "pl011",
    .version_id = 2,
    .minimum_version_id = 2,
    .post_load = pl011_post_load,
    .fields = (const VMStateField[]) {
        VMSTATE_UINT32(flags, PL011State),
        VMSTATE_UINT32(lcr, PL011State),
        VMSTATE_UINT32(int_enabled, PL011State),
        VMSTATE_UINT32(int_level, PL011State),
        VMSTATE_UINT32_ARRAY(read_fifo, PL011State, PL011_FIFO_DEPTH),
        VMSTATE_INT32(read_pos, PL011State),
        VMSTATE_INT32(read_count, PL011State),
        VMSTATE_END_OF_LIST()
    },
    .subsections = (const VMStateDescription * const []) {
        &vmstate_pl011_clock,
        NULL
    }
};
```

`pl011_clock_update` 当前主要用于追踪时钟变化；如果你扩展波特率建模，它是一个自然的入口。

## 本章小结

PL011 展示了 QEMU 外设建模的完整路径：QOM 注册 → 状态建模 → MMIO 回调 → FIFO 与中断 → 机型集成 → 迁移支持。掌握这条建模主线后，建模其他串口或简单 MMIO 设备会非常顺滑。
