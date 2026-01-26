# QEMU 主板建模流程

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

QEMU 里的“主板”对应 machine model（机型）。它不是一颗 CPU，也不是单个外设，而是**把 CPU 拓扑、内存布局、总线、外设、中断路由、固件入口**统一编排起来的一层“板级模型”。

!!! tip "概览"

    - 主板模型的职责范围与关键概念
    - QOM 类型注册与 MachineClass 配置
    - 机型选择与创建流程（-machine → init）
    - 以 virt 为例的 CPU/内存/中断/外设组装
    - 常见关键点与调试入口

## 基本概念

- **机器类型（-machine）**：选择主板模板，如 `virt`、`pc-q35`。
- **CPU 型号（-cpu）**：选择 CPU 实现，如 `rv64`、`cortex-a57`。
- **主板职责**：定义内存地图、外设挂载、IRQ 连接、固件/设备树生成等。

从用户视角看，`-machine` 决定“整机框架”，`-cpu` 决定“CPU 细节”。QEMU 文档里对 `-machine` 选项有完整说明。

## QOM 关系

QEMU 的主板模型也是 QOM 类型的一种：每个机型通过 `TypeInfo` 注册，继承 `TYPE_MACHINE`，并在类初始化中挂载自己的 `init` 回调与默认属性。

下面以 RISC-V `virt` 为例（`hw/riscv/virt.c`），可以看到 `MachineClass` 的配置与 `TypeInfo` 注册：

```c
/* hw/riscv/virt.c */
static void virt_machine_class_init(ObjectClass *oc, const void *data)
{
    MachineClass *mc = MACHINE_CLASS(oc);

    mc->desc = "RISC-V VirtIO board";
    mc->init = virt_machine_init;
    mc->max_cpus = VIRT_CPUS_MAX;
    mc->default_cpu_type = TYPE_RISCV_CPU_BASE;
    mc->default_ram_id = "riscv_virt_board.ram";
}

static const TypeInfo virt_machine_typeinfo = {
    .name       = MACHINE_TYPE_NAME("virt"),
    .parent     = TYPE_MACHINE,
    .class_init = virt_machine_class_init,
    .instance_init = virt_machine_instance_init,
    .instance_size = sizeof(RISCVVirtState),
};
```

QOM 文档强调：类型注册、单继承、多接口和属性系统是 QEMU 设备/主板组织的基础。[1]

## 创建流程

创建主板的流程大致是：解析 `-machine`，选择机型类，实例化 MachineState，并在初始化阶段调用 `mc->init()`。

在 `system/vl.c` 中，`select_machine()` 负责匹配机型：

```c
/* system/vl.c */
static MachineClass *select_machine(QDict *qdict, Error **errp)
{
    const char *machine_type = qdict_get_try_str(qdict, "type");
    g_autoptr(GSList) machines = object_class_get_list(target_machine_typename(),
                                                       false);

    if (machine_type) {
        machine_class = find_machine(machine_type, machines);
        ...
    } else {
        machine_class = find_default_machine(machines);
        ...
    }

    return machine_class;
}
```

随后 `qemu_create_machine()` 实例化主板对象：

```c
/* system/vl.c */
static void qemu_create_machine(QDict *qdict)
{
    MachineClass *machine_class = select_machine(qdict, &error_fatal);

    current_machine = MACHINE(object_new_with_class(OBJECT_CLASS(machine_class)));
    object_property_add_child(object_get_root(), "machine",
                              OBJECT(current_machine));
    ...
}
```

最终在 `machine_run_board_init()` 中调用板级初始化函数：

```c
/* hw/core/machine.c */
void machine_run_board_init(MachineState *machine, const char *mem_path, Error **errp)
{
    ...
    accel_init_interfaces(ACCEL_GET_CLASS(machine->accelerator));
    machine_class->init(machine);
    phase_advance(PHASE_MACHINE_INITIALIZED);
}
```

这条链路和 2025 训练营文档里的“机器创建流程”是一致的，只是这里更聚焦主板本身的职责。

## 板级例子

仍以 RISC-V `virt` 为例，`virt_machine_init()` 会按 socket 创建 CPU 集群，并配置 hart 号与数量：

```c
/* hw/riscv/virt.c */
for (i = 0; i < socket_count; i++) {
    g_autofree char *soc_name = g_strdup_printf("soc%d", i);

    object_initialize_child(OBJECT(machine), soc_name, &s->soc[i],
                            TYPE_RISCV_HART_ARRAY);
    object_property_set_str(OBJECT(&s->soc[i]), "cpu-type",
                            machine->cpu_type, &error_abort);
    object_property_set_int(OBJECT(&s->soc[i]), "hartid-base",
                            base_hartid, &error_abort);
    object_property_set_int(OBJECT(&s->soc[i]), "num-harts",
                            hart_count, &error_abort);
    sysbus_realize(SYS_BUS_DEVICE(&s->soc[i]), &error_fatal);
}
```

在完整实现里，主板还会：

- 分配内存区域（RAM/ROM/MMIO）；
- 初始化中断控制器（PLIC/ACLINT/IMSIC 等）；
- 挂载串口、RTC、PCIe、virtio-mmio；
- 生成 FDT 或 ACPI 表。

这就是“主板模型”的核心：把 CPU 与外设组织成一个可启动的系统。

## 关键点

- **板级边界**：machine 关注整机级拓扑与总线连接，而不是单一设备实现细节。
- **可配置字段**：如 `mc->max_cpus`、`mc->default_cpu_type`、`mc->default_ram_id` 等决定默认行为。
- **调试入口**：监控器里可用 `info qom-tree` 查看对象树，定位主板创建了哪些对象。[1]

!!! tip "训练提示"

    初学者可以先掌握两件事：

    1. `-machine` 决定主板骨架，`-cpu` 决定处理器细节；
    2. 主板 init 里一定能看到“CPU + 内存 + 中断 + 基础外设”的初始化顺序。

## 本章小结

主板模型是 QEMU 系统模拟的“总装线”。它在 QOM 类型系统中注册为 `TYPE_MACHINE` 的子类，负责选择 CPU、分配内存、搭建总线和外设，并在 `mc->init()` 中完成整机组装。理解这一层，后续阅读设备模型或加速器代码会更清晰。

!!! tip "进一步阅读"

    - QEMU Object Model（QOM）文档。[1]
    - QEMU User Documentation：`-machine` 选项说明。[2]

[1]: https://qemu-project.gitlab.io/qemu/devel/qom.html
[2]: https://www.qemu.org/docs/master/system/qemu-manpage.html
