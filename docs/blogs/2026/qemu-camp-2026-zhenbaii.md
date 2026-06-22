# QEMU 训练营 2026 专业阶段总结

!!! note "主要贡献者"

    - 作者：[@zhenbaii](https://github.com/zhenbaii)

---

## 背景介绍

我是一名研一的工科研究生. 去年参加了rCore的训练营项目, 完整参与了整个操作系统内核的开发, 收获颇深, 于是沿着社区的动态一路找到了这次的QEMU训练营. 简单地看了一眼后, 发现不仅免费, 而且质量上乘, 所以就决定参加. 并且, 我看到了项目阶段的那几个项目, 我都有比较大的兴趣, 因此决定不走马观花, 争取进入项目阶段.

---

## 开发环境

| 项目 | 说明 |
|------|------|
| 主力机 | Windows + Ubuntu双系统, 主要在Ubuntu上做开发工作 |
| AI工具 | Trae + deepseek-v4 pro |

---

## 专业阶段

之前参加了操作系统训练营, 对操作系统有了初步的认知, 但是对操作系统的载体, 即SoC, 还处在比较模糊的认知阶段. 因此, 我决定从**SoC建模**出发, 来更加熟悉SoC的整体架构.

下面, 记录我对于SoC建模的**学习过程**.

### 核心板建模
SoC建模, 无非就是核心板 + 外设的建模, 核心板建模, 主要涉及 **CPU、内存、中断控制器、外设** 等组件的建模. 外设建模, 主要涉及 **GPIO、SPI、UART、I2C、SPI** 等组件的建模. 好在, 核心板的建模在今年的训练营中已经事先提供了, 我们只需要阅读源码来学习整体的建模思路. 关于核心板的建模代码都集中在了`hw/riscv/g233.c`和`include/hw/riscv/g233.h`两个文件中. 

核心板的建模流程集中体现在 [`virt_machine_init`](file:///home/holo/qemu_camp/qemu-camp-2026-exper-zhenbaii/hw/riscv/g233.c#L1591) 函数中, 下面按照初始化顺序逐一拆解.

#### 1. 内存映射

在 QEMU 中, 一个 SoC 的物理地址空间通过内存映射表来定义. [`g233.c`](file:///home/holo/qemu_camp/qemu-camp-2026-exper-zhenbaii/hw/riscv/g233.c#L72-L100) 中定义了一个 `virt_memmap` 数组, 每个设备都分配了一个枚举索引和对应的基地址 + 大小:

```c
static const MemMapEntry virt_memmap[] = {
    [VIRT_MROM] =         {     0x1000,        0xf000 },
    [VIRT_TEST] =         {   0x100000,        0x1000 },
    [VIRT_CLINT] =        {  0x2000000,       0x10000 },
    [VIRT_PLIC] =         {  0xc000000, VIRT_PLIC_SIZE(...) },
    [VIRT_UART0] =        { 0x10000000,         0x100 },
    [VIRT_GPIO] =         { 0x10012000,        0x100 },
    [VIRT_SPI] =          { 0x10018000,        0x1000 },
    [VIRT_DRAM] =         { 0x80000000,           0x0 },
    // ... 更多设备
};
```

每个枚举值对应一个 SoC 组件, 整体地址布局一目了然. 后续所有设备的创建都会引用这张表来获取基地址.

#### 2. CPU 建模 —— Hart Array

RISC-V 中的「核心」称为 **Hart**（硬件线程）. QEMU 用一个 `RISCVHartArrayState` 对象来管理一组 Hart. 代码中为每个 socket 创建一个 hart 数组:

```c
object_initialize_child(OBJECT(machine), soc_name, &s->soc[i],
                        TYPE_RISCV_HART_ARRAY);
object_property_set_str(OBJECT(&s->soc[i]), "cpu-type",
                        machine->cpu_type, &error_abort);
object_property_set_int(OBJECT(&s->soc[i]), "hartid-base",
                        base_hartid, &error_abort);
object_property_set_int(OBJECT(&s->soc[i]), "num-harts",
                        hart_count, &error_abort);
sysbus_realize(SYS_BUS_DEVICE(&s->soc[i]), &error_fatal);
```

这里的关键参数是：
- `cpu-type`：指定 CPU 型号（如 `rv64imafdc`）
- `hartid-base`：该 socket 的起始 hart ID
- `num-harts`：该 socket 包含的 hart 数量

通过 QEMU 的 QOM（QEMU Object Model）属性系统设置完参数后, 调用 `sysbus_realize` 完成实例化. 这个模式贯穿整个核心板建模：**创建对象 → 设置属性 → realize 实例化**.

#### 3. 中断控制器

SoC 的中断系统分两层：**核内中断**和**外部中断**.

**核内中断**: 由 ACLINT（或 CLINT）提供, 包含：
- **MSWI**（Machine Software Interrupt）: 跨核软件中断
- **MTIMER**（Machine Timer）: 核内定时器中断
- **SSWI**（Supervisor Software Interrupt）: S 态软件中断

代码中通过辅助函数创建：
```c
riscv_aclint_swi_create(..., hart_count, false);   // MSWI
riscv_aclint_mtimer_create(..., hart_count, ...);   // MTIMER
riscv_aclint_swi_create(..., hart_count, true);    // SSWI
```

当使用 AIA（Advanced Interrupt Architecture）的 IMSIC 模式时, IMSIC 会接管核内中断, 此时只需创建 MTIMER.

**外部中断**: 由 PLIC（平台级中断控制器）或 APLIC+IMSIC 管理. 它接收所有外设的中断信号, 再分发给各 CPU:

```c
s->irqchip[i] = virt_create_plic(s->memmap, i, base_hartid, hart_count);
```

PLIC 的核心参数包括：中断源数量 `VIRT_IRQCHIP_NUM_SOURCES`（96 个）、优先级位数（3 bit）, 以及映射到每个 hart 的中断使能/上下文寄存器地址.

如果使用 AIA 的高级模式, 则改用 APLIC + IMSIC 方案, 支持 MSI 传递和虚拟化场景.

#### 4. 内存注册

CPU 和中断控制器就绪后, 需要注册物理内存. DRAM 直接通过 `memory_region_add_subregion` 挂载到系统地址空间：

```c
memory_region_add_subregion(system_memory, s->memmap[VIRT_DRAM].base,
                            machine->ram);
```

Boot ROM（MROM）同样方式注册, 用于存放复位向量和固件入口代码：

```c
memory_region_init_rom(mask_rom, NULL, "riscv_virt_board.mrom",
                       s->memmap[VIRT_MROM].size, &error_fatal);
memory_region_add_subregion(system_memory, s->memmap[VIRT_MROM].base,
                            mask_rom);
```

#### 5. 外设注册与接线

有了 CPU、中断控制器和内存后, 就可以向总线上安装外设了. QEMU 中的标准做法是两步走：

- **`sysbus_mmio_map`**：将设备的 MMIO 寄存器区域映射到物理地址空间的某个位置
- **`sysbus_connect_irq`**：将设备的中断输出连接到中断控制器的某个输入引脚

简单外设可以使用 `sysbus_create_simple` 一步完成, 例如 GPIO：

```c
sysbus_create_simple(TYPE_G233_GPIO, s->memmap[VIRT_GPIO].base,
    qdev_get_gpio_in(mmio_irqchip, 2));   // IRQ 2 = GPIO
```

这条语句做了三件事：创建设备、将 MMIO 映射到 `0x10012000`、将中断线连接到 PLIC 的 IRQ 2.

对于较复杂的外设（如 SPI）, 需要手动展开：

```c
DeviceState *spi_dev = qdev_new(TYPE_G233_SPI);
SSIBus *spi_bus;

sysbus_realize_and_unref(SYS_BUS_DEVICE(spi_dev), &error_fatal);
sysbus_mmio_map(SYS_BUS_DEVICE(spi_dev), 0, s->memmap[VIRT_SPI].base);
sysbus_connect_irq(SYS_BUS_DEVICE(spi_dev), 0,
                   qdev_get_gpio_in(mmio_irqchip, 5));
```

然后再在 SPI 总线上挂 Flash 从设备, 实现多级设备树的建模.

通过以上五个步骤, 核心板就建模完成了. 总结核心流程就是：

> **定义内存映射 → 创建 CPU → 搭建中断控制器 → 注册内存 → 接线外设**

这套模式是 QEMU SoC 建模的通用范式, 掌握了它, 无论是看其他开发板代码还是自己添加新外设, 都能快速上手.

#### 6. 设备树生成

设备和中断都接好线了, 但操作系统怎么知道这些设备的存在和地址？答案是 **设备树（FDT，Flattened Device Tree）**. QEMU 在初始化完成后会生成一份设备树, 作为启动参数传递给内核, 内核通过解析设备树来发现所有硬件.

生成过程分两阶段：

**骨架创建** —— [`create_fdt`](file:///home/holo/qemu_camp/qemu-camp-2026-exper-zhenbaii/hw/riscv/g233.c#L1220) 函数负责创建 FDT 的顶层结构：

```c
ms->fdt = create_device_tree(&s->fdt_size);

qemu_fdt_setprop_string(ms->fdt, "/", "model", "gevico-g233,qemu");
qemu_fdt_setprop_string(ms->fdt, "/", "compatible", "riscv-virtio");

qemu_fdt_add_subnode(ms->fdt, "/soc");
qemu_fdt_setprop_string(ms->fdt, "/soc", "compatible", "simple-bus");

qemu_fdt_add_subnode(ms->fdt, "/chosen");

create_fdt_flash(s);
create_fdt_fw_cfg(s);
create_fdt_pmu(s);
```

这里搭建了最外层的框架：根节点 `/`、总线容器 `/soc`、启动参数 `/chosen`, 以及一些在早期就需要确定的节点（Flash、fw_cfg、PMU）.

**设备节点填充** —— 当所有设备都实例化完成后, [`finalize_fdt`](file:///home/holo/qemu_camp/qemu-camp-2026-exper-zhenbaii/hw/riscv/g233.c#L1192) 被调用, 遍历所有外设并逐个填充设备树节点：

```c
create_fdt_sockets(s, ...);    // CPU + 中断控制器 + 内存
create_fdt_virtio(s, ...);     // VirtIO 设备
create_fdt_pcie(s, ...);       // PCIe 总线
create_fdt_uart(s, ...);       // 串口
create_fdt_rtc(s, ...);        // 实时时钟
```

每个设备的 FDT 节点都遵循统一格式. 以 UART 为例：

```c
name = g_strdup_printf("/soc/serial@%"HWADDR_PRIx,
                       s->memmap[VIRT_UART0].base);
qemu_fdt_add_subnode(ms->fdt, name);
qemu_fdt_setprop_string(ms->fdt, name, "compatible", "ns16550a");
qemu_fdt_setprop_sized_cells(ms->fdt, name, "reg",
                             2, s->memmap[VIRT_UART0].base,
                             2, s->memmap[VIRT_UART0].size);
qemu_fdt_setprop_cell(ms->fdt, name, "interrupt-parent", irq_mmio_phandle);
qemu_fdt_setprop_cell(ms->fdt, name, "interrupts", UART0_IRQ);
qemu_fdt_setprop_string(ms->fdt, "/chosen", "stdout-path", name);
```

可以看到, 一个设备节点需要填写的关键字段是：

| 字段 | 说明 |
|------|------|
| `compatible` | 驱动匹配字符串（如 `ns16550a`）, 操作系统据此加载对应驱动 |
| `reg` | 设备的 MMIO 基地址和大小, 与 `virt_memmap` 表中的定义一致 |
| `interrupt-parent` | 指向中断控制器的 phandle, 用于声明中断归属 |
| `interrupts` | 中断号, PLIC 模式下填一位, AIA 模式下填两位（中断号 + 电平/边沿类型） |

最终设备树在 `virt_machine_done` 中通过 `riscv_load_fdt` 加载到物理内存的约定位置, 和 firmware、kernel 一起构成完整的启动信息包.

---

### 外设建模

核心板跑通后, 接下来就是给 SoC 添加外设.

虽然外设功能各异, 但代码结构高度统一.

#### 统一的骨架

四个外设的源码文件命名完全一致 —— `g233_xxx.c` + `g233_xxx.h`, 分布在对应的模块目录下：

| 外设 | 源文件 | 头文件 |
|------|--------|--------|
| GPIO | `hw/gpio/g233_gpio.c` | `include/hw/gpio/g233_gpio.h` |
| WDT  | `hw/watchdog/g233_wdt.c` | `include/hw/watchdog/g233_wdt.h` |
| PWM  | `hw/timer/g233_pwm.c` | `include/hw/timer/g233_pwm.h` |
| SPI  | `hw/ssi/g233_spi.c` | `include/hw/ssi/g233_spi.h` |

每个外设的代码都由以下组件按固定顺序组成, 我们可以把它看作一个**外设模板**：

> **TypeInfo 注册 → State 结构体 → instance_init → class_init(reset) → MMIO read/write → IRQ 更新**

#### 1. QOM 类型注册与 State 结构体

每个外设在 QOM 中都是一个类, 通过 `TypeInfo` 描述, 再通过 `type_init` 注册到全局类型表. 以 GPIO 为例：

```c
static const TypeInfo g233_gpio_info = {
    .name = TYPE_G233_GPIO,           // 类名字符串 "riscv.g233.gpio"
    .parent = TYPE_SYS_BUS_DEVICE,    // 继承自 SysBusDevice
    .instance_size = sizeof(G233GPIOState),
    .instance_init = g233_gpio_init,  // 对象构造
};

static void g233_gpio_register_types(void)
{
    type_register_static(&g233_gpio_info);
}
type_init(g233_gpio_register_types)
```

所有外设都继承自 `TYPE_SYS_BUS_DEVICE`, 因此 State 结构体的第一个字段一定是 `SysBusDevice`, 这是 C 语言实现继承的惯用手法——子结构体在内存布局上是父结构体的超集, 指针可以安全地在父子之间转换. 结构体内部再放上 MMIO 区域、中断线、寄存器数组等：

```c
// GPIO 结构体 —— 最简单也最典型的形态
struct G233GPIOState {
    SysBusDevice parent_obj;
    MemoryRegion mmio;
    uint32_t regs[G233_GPIO_NREGS];
    qemu_irq irq;
};

// WDT 在此基础上多了 ptimer 和 start_ns
struct G233WDTState {
    SysBusDevice parent;
    uint32_t regs[G233_WDT_NREGS];
    uint64_t start_ns;
    MemoryRegion mmio;
    qemu_irq irq;
    QEMUTimer timer;
};

// SPI 多了一个 SSIBus 和多个片选信号线
struct G233SPIState {
    SysBusDevice parent;
    MemoryRegion mmio;
    uint32_t regs[G233_SPI_NREGS];
    qemu_irq irq;
    SSIBus *spi;
    qemu_irq cs_lines[G233_SPI_NUM_CS];
};
```

四个结构体的共同点一目了然 —— `SysBusDevice` + `MemoryRegion` + `qemu_irq` + 寄存器数组. 差异部分取决于外设功能（Timer、子总线、片选等）.

#### 2. instance_init —— 出口初始化

`instance_init` 是对象构造时调用的第一个函数, 负责初始化 MMIO 区域和中断输出线. 这四者在这一步几乎完全相同：

```c
static void g233_gpio_init(Object *obj)
{
    G233GPIOState *g = G233_GPIO(obj);
    // 创建 MMIO 区域, 绑定 read/write 回调
    memory_region_init_io(&g->mmio, obj, &g233_gpio_ops, g,
                          TYPE_G233_GPIO, 0x100);
    // 将 MMIO 区域注册为设备的总线输出端口
    sysbus_init_mmio(SYS_BUS_DEVICE(obj), &g->mmio);
    // 声明中断输出线
    sysbus_init_irq(SYS_BUS_DEVICE(obj), &g->irq);
}
```

三句话总结出口初始化：**造一片内存区域 → 接到 MMIO 总线上 → 引出一根 IRQ 线**. WDT 和 PWM 还会在 `instance_init` 中初始化 `QEMUTimer`, SPI 则在 `realize` 中做这些（因为 SPI 需要先创建 SSIBus 才能初始化 CS 信号线）.

#### 3. MMIO 读写回调

CPU 访问外设的寄存器本质上是对映射地址做 load/store 指令. QEMU 通过 `MemoryRegionOps` 结构将地址访问路由到对应的 read/write 函数：

```c
static const MemoryRegionOps g233_gpio_ops = {
    .read = g233_gpio_read,
    .write = g233_gpio_write,
    .endianness = DEVICE_NATIVE_ENDIAN,
    .valid = {
        .min_access_size = 4,     // 只允许 4 字节对齐访问
        .max_access_size = 4
    }
};
```

四个外设的 ops 结构完全一致 —— 都是 4 字节对齐、小端、一个 read + 一个 write.

**read 的通用模式**：用 `addr` 做 switch-case, 返回对应寄存器的值. 对于会随时间变化的寄存器（如 WDT 的 CNT、PWM 的 CNT）, 在 read 时动态计算, 而不是真正去维护一个递减的计数器, 即QEMU做的是功能级别的仿真, 而不是时序级别或者说硬件级别的, 只要功能和真实硬件是幂等的, 就说明我们的建模是成功的：

```c
// WDT: CPU 读 CNT 时, 根据当前时间和 start_ns 反算剩余值
static uint32_t doWDTReadCNT(G233WDTState *wdt) {
    uint64_t elapsed = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) - wdt->start_ns;
    uint64_t elapsed_ticks = elapsed / WDT_TICK_NS;
    if (elapsed_ticks >= wdt->regs[G233_WDT_LOAD >> 2])
        return 0;
    return wdt->regs[G233_WDT_LOAD >> 2] - elapsed_ticks;
}
```

这是一个重要的建模技巧 —— **不模拟硬件电路的真实节拍, 而是在访存时用 QEMU 的虚拟时钟反算, 实现相同的可观测行为**.

**write 的通用模式**：同样是 switch-case, 但多了副作用处理 —— 更新寄存器值后, 需要重新评估中断状态. 例如 GPIO 写 OUT/DIR/TRIG/POL 后要调 `g233_gpio_recalc` 重新计算引脚电平, WDT 写 KEY 后要判断是不是喂狗命令.

#### 4. 中断信号管理

每个外设都有一个统一的 `g233_xxx_update_irq` 函数, 负责根据当前寄存器状态决定 IRQ 线的电平：

```c
// GPIO: 任意 IE & IS 不为零就拉高
static void g233_gpio_update_irq(G233GPIOState *g) {
    uint32_t pending = g->regs[G233_GPIO_IE >> 2] & g->regs[G233_GPIO_IS >> 2];
    qemu_set_irq(g->irq, pending ? 1 : 0);
}

// SPI: RXNE/TXE/OVERRUN 三个中断源, 各自需要使能位匹配
static void g233_spi_update_irq(G233SPIState *spi) {
    bool rxne    = (sr & RXNE)    && (cr1 & RXNEIE);
    bool txe     = (sr & TXE)     && (cr1 & TXEIE);
    bool overrun = (sr & OVERRUN) && (cr1 & ERRIE);
    qemu_set_irq(spi->irq, (rxne || txe || overrun) ? 1 : 0);
}
```

这里 `qemu_irq` 虽然名字带 "IRQ", 但本质只是一条布尔信号线. 在 GPIO/WDT/PWM 中它是中断线, 连到 PLIC; 在 SPI 中它还用来表示片选信号（CS）, 连到 Flash 从设备. 设计原则是：**任意会改变中断/信号状态的寄存器写操作, 结束后都要调一次 update_irq**.

#### 5. class_init 与 reset

如果需要复位逻辑, 则提供 `class_init`, 在其中挂接 reset 回调：

```c
static void g233_wdt_class_init(ObjectClass *klass, const void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    device_class_set_legacy_reset(dc, g233_wdt_reset);
}
```
reset 函数负责**初始化状态**（寄存器复位值、计数器初值）, 与 `instance_init` 的**分配资源**明确分离：

```c
static void g233_spi_reset(DeviceState *dev) {
    G233SPIState *spi = G233_SPI(dev);
    memset(spi->regs, 0, sizeof(spi->regs));
    spi->regs[G233_SPI_SR >> 2] = G233_SPI_SR_TXE;  // 复位后 TX 为空
    for (int i = 0; i < G233_SPI_NUM_CS; i++)
        qemu_set_irq(spi->cs_lines[i], 1);           // 所有 CS 初始为高（未选中）
}
```

#### 6. 构建系统：Kconfig 与 meson

每新增一个外设, 还需要在构建系统中注册. 这涉及到三个必须一致的名字：

- `hw/xxx/Kconfig` 中声明 `config G233_YYY`
- `hw/xxx/meson.build` 中写 `when: 'CONFIG_G233_YYY'`
- `hw/riscv/Kconfig` 中用 `select G233_YYY` 启用

三处只要有一处不一致, 结果就是"文件不被编译"或"Kconfig 找不到 select 目标", 通常要到运行时才会暴露.

---

## 总结

最大的收获是对SoC的结构和职责相比之前有了更加清晰的认知. 而且, 对于**QEMU负责功能级别的仿真**这一点有了更加实际的理解. 在专业阶段中, 对于涉及到定时器的外设的建模, 我曾试图用定时器+中断的方式去模拟真实时钟中的上升沿和下降沿, 后来发现这是不对的, QEMU负责的是功能级别的仿真, 而不需要精确模拟硬件时序, 只要对外暴露的功能和实际硬件是幂等的, 就说明我们的建模是成功的.

除此之外, 我还掌握了自己操控底板的能力. 我基于之前的rCore项目做了很多二次开发, 上个月就一直在试图搭建一个简单的仿照Linux的设备驱动框架, 其中很多的调试步骤都依赖在设备树中添加一些哨兵节点. **通过这次训练营, 我成功地把rCore移植到了这次的g233板子上, 并且掌握了在设备树上添加各种测试节点的方式, 并且也借此机会对设备树有了更加深入的理解.** 这对我的设备驱动框架的调试与开发产生了莫大的帮助. 在后续我对rCore的更多二次开发的过程中, 我应该也会频繁地依赖本次的训练营项目, 两个项目互相推动. 总之十分感谢搭建本次训练营的各位无私的开发者们!