# QEMU CPU 建模流程：以 RISC-V 为例

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

在 QEMU 中为 RISC-V 架构添加一个新的 CPU 模型，其核心是建立在 QOM（QEMU Object Model）框架之上的。整个建模过程遵循 QEMU 设备模型的通用范式，但融入了 RISC-V 特有的扩展管理、多核拓扑和特权级架构。比如 QEMU RISC-V 包含了一个 RISCVCPUConfig 数据结构，允许为不同类型的 CPU，绑定对应的扩展，极大地的提高了灵活性和可维护性。

!!! tip "概览"

    - CPU 模型在 QEMU 初始化链路中的位置与职责
    - RISC-V CPU 的 QOM 继承关系与关键结构
    - 定义新 CPU 类型与 RISCVCPUDef 配置流程
    - 添加指令集扩展与特权/向量规范
    - 在主板与命令行中启用新 CPU

## 整体分析

我们可以从 QEMU 初始化的流程，来看看 CPU 模型在哪个环节被实例化：

```bash
QEMU 命令行 (-M virt -cpu rv64,...)
        ↓
选择并实例化机器模型 (RISCVVirtState)
        ↓
创建 CPU 集群 (RISCVHartArrayState)
        ↓
初始化具体 CPU 核心 (RISCVCPU) → 加载配置 (RISCVCPUConfig)
        ↓
TCG 前端翻译指令 → 后端生成主机代码
        ↓
CPU 主循环执行 → 处理中断/异常/CSR访问
        ↓
集成平台外设 → 启动操作系统
```

可以看到，QEMU 的 CPU 模拟是一个多层次协作的体系，在初始化阶段，CPU 模型依托所属的板卡进行实例化，目前单张板卡只支持同构的 CPU 处理器模型；在运行阶段，主要通过模拟 CPU 的指令执行，来驱动整个仿真环境的状态更新。

所有硬件在 QEMU 中都是对象。RISC-V CPU 的 QOM 继承链清晰地定义了从通用设备到具体 CPU 模型的层次关系。下面给出一个 QOM 与 RISC-V 的关系图（摘自 [PLCT Lab · 从零开始的 RISC-V 模拟器开发][1]）

```bash
                                                                                  +--------------------------+
                                                                                  | TYPE_RISCV_CPU_MAX       |
                                                                                  +--------------------------+
  cpu base type                                                                   | TYPE_RISCV_CPU_BASE32    |
+---------------+    +---------------+   +------------+     +----------------+    +--------------------------+
|  TYPE_OBJECT  +--->|  TYPE_DEVICE  +-->|  TYPE_CPU  +---->| TYPE_RISCV_CPU +--> | TYPE_RISCV_CPU_SHAKTI_C  |
+---------------+    +---------------+   +------------+     +----------------+    +--------------------------+
                                                                                  | TYPE_RISCV_CPU_VEYRON_V1 |
  cpu class (interface)                                                           +--------------------------+
+---------------+    +---------------+   +------------+     +---------------+     | TYPE_RISCV_CPU_HOST      |
|  ObjectClass  +--->|  DeviceClass  +-->|  CPUClass  +---->| RISCVCPUClass |     +--------------------------+
+---------------+    +---------------+   +------------+     +---------------+

  cpu object (property)
+---------------+    +---------------+   +------------+     +-------------------+
|  Object       +--->|  DeviceState  +-->|  CPUState  +---->| RISCVCPU(ArchCPU) |
+---------------+    +---------------+   +------------+     +-------------------+
```


## 添加新 CPU 类型

现在我们尝试，为一个假设的 RISC-V 64 位 CPU 型号（例如 g233-cpu）创建其 QEMU 模型。整个过程严格遵循 QOM 框架，核心是定义静态“蓝图”（RISCVCPUDef）并将其绑定到一个新的 QOM 类型上。实际流程并不复杂（照葫芦画瓢即可），不同的 target 大致流程类似，具体步骤如下：

- **定义 CPU 类型标识符（Type Name）**：在 QEMU 的 QOM 系统中，每个对象类型都有一个唯一的字符串名称。对于 CPU 类型，RISC-V 提供了便利的宏来生成标准化的名称。一般在 `cpu-qom.h` 中定义。使用 `RISCV_CPU_TYPE_NAME()` 宏为新的 CPU 定义一个类型标识符。这个宏确保了命名的一致性。

    ```c
    // path: target/riscv/cpu-qom.h
    #define TYPE_RISCV_CPU_G233       RISCV_CPU_TYPE_NAME("g233-cpu")
    ```
    此后，在代码中即可使用 `TYPE_RISCV_CPU_G233` 来指代这个新类型，其对应的类型字符串是“g233-cpu”。用户未来在命令行将通过 `-cpu g233-cpu` 来指定它。

- **定义 CPU 的静态蓝图（RISCVCPUDef）**：`RISCVCPUDef` 结构体描述了 CPU 型号的所有静态、不可变的属性，如最大字长、默认启用的指令集扩展、特权架构版本等。这些信息在类初始化时被载入，并成为后续实例配置的基准。

    ```c
    /* target/riscv/cpu.c */
    static const RISCVCPUDef g233_cpu_def = {
        .name = TYPE_RISCV_CPU_G233,
        .misa_mxl_max = MXL_RV64, /* 最大支持 RV64 */
        .misa_ext = RVI | RVM | RVA | RVC | RVU, /* 默认启用 I, M, A, C, U 扩展 */
        .priv_spec = PRIV_VERSION_1_12_0, /* 遵循 v1.12 特权规范 */
        .vext_spec = VEXT_VERSION_1_00_0, /* 向量扩展规范版本 (如果支持) */
        .cfg = {
            .ext_zicsr = true, /* 启用 CSR 指令 */
            .ext_zifencei = true, /* 启用指令栅栏 */
            .mmu = true, /* 支持内存管理单元 */
            .pmp = true, /* 支持物理内存保护 */
            .max_satp_mode = VM_1_10_SV39, /* 默认最高支持 Sv39 虚拟内存方案 */
            /* 可根据需要启用更多扩展，例如： */
            /* .ext_zba = true, */
            /* .ext_zbb = true, */
        },
    };
    ```
    `cfg` 字段是一个 `RISCVCPUConfig` 结构体实例，它包含了所有可配置扩展的布尔开关。

- **创建 QOM 类型并绑定蓝图**：现在需要创建一个继承自 `TYPE_RISCV_CPU` 的新 QOM 类型，并在其类初始化函数中，将上一步定义的 `g233_cpu_def` 赋值给 `RISCVCPUClass`。

    ```c
    /* target/riscv/cpu.c */

    /*
     * 声明类型相关的结构体和函数：
     * 虽然新类型本身不增加新的实例字段，但为了使用 QOM 宏，仍需进行声明。
     * 在 cpu.c 文件顶部附近或其他合适位置，为这个新类型声明类结构体和初始化函数。
     */
    #define RISCV_CPU_CLASS(klass) \
        OBJECT_CLASS_CHECK(RISCVCPUClass, (klass), TYPE_RISCV_CPU)
    #define RISCV_CPU_GET_CLASS(obj) \
        OBJECT_GET_CLASS(RISCVCPUClass, (obj), TYPE_RISCV_CPU)

    /* 新类型的类初始化函数声明 */
    static void g233_cpu_class_init(ObjectClass *oc, void *data);
    /* 新类型的实例初始化函数（可选，用于更复杂的实例设置） */
    static void g233_cpu_init(Object *obj);

    /* 这是最关键的一步，将静态蓝图 (RISCVCPUDef) 关联到动态的类 (RISCVCPUClass) 上。 */
    static void g233_cpu_class_init(ObjectClass *oc, void *data)
    {
        DeviceClass *dc = DEVICE_CLASS(oc);
        RISCVCPUClass *rcc = RISCV_CPU_CLASS(oc);
        rcc->def = &g233_cpu_def; /* 绑定到类 */
        /* 可以在此设置设备类相关的属性，但 CPU 核心设置通常已在通用类初始化中完成 */
    }
    ```
- **将类型信息注册到 QOM 系统**：最后，需要将新类型的 `TypeInfo` 描述添加到全局的类型信息数组中，以便 QEMU 在启动时能够识别它。

    ```c
    static const TypeInfo riscv_cpu_type_infos[] = {
        /* ... 其他已有 CPU 类型的定义，例如 base, sifive-u54, host ... */
        {
            .name = TYPE_RISCV_CPU_G233,
            .parent = TYPE_RISCV_CPU,
            .instance_size = sizeof(RISCVCPU),
            .instance_init = mycpu64_cpu_init, /* 可选的实例初始化 */
            .class_size = sizeof(RISCVCPUClass),
            .class_init = mycpu64_cpu_class_init, /* 指向我们刚实现的函数 */
        },
    };
    ```

    `riscv_cpu_type_infos` 数组最终通过 `type_init` 或相关的模块注册机制被处理。在 RISC-V 代码中，通常使用 `DEFINE_TYPES(riscv_cpu_type_infos)` 宏来完成所有 CPU 类型的统一注册。只要我们的新条目在数组中，就会被自动注册。

完成上述代码修改并重新编译 QEMU 后，即可验证新 CPU 类型是否成功注册。运行 `qemu-system-riscv64 -cpu help` 命令，你应在输出的 CPU 型号列表中看到 `g233-cpu`。

也可以使用 `-cpu g233-cpu` 参数启动一个虚拟机（例如 virt 主板）。如果启动成功，并在后续的 `info qom-tree` 或 `info registers` 等监控命令中看到对应的 CPU 对象和正确的扩展状态（如 MISA 寄存器值），即证明注册成功。

```bash
qemu-system-riscv64 -M virt -cpu g233-cpu \
    -nographic -bios none \
    -kernel your_kernel_image
```

至此，你已经完成了一个全新的 RISC-V CPU 型号在 QEMU 中的基础定义与注册。它现在拥有了自己的默认配置身份，可以被用户和机器模型引用。接下来的章节将讨论如何为这个新 CPU 添加指令扩展，并最终集成到特定的 virt 主板环境中。

## 添加指令集扩展

指令集扩展通过 `RISCVCPUConfig` 结构体来配置，每个扩展对应一个 bool 类型的成员变量。

这个结构体在 `target/riscv/cpu_cfg.h` 中定义。

指令集扩展的配置，是在 CPU 初始化时，通过 `cpu->cfg` 来配置的。

也就是前面定义 CPU 的类型时，调用的 class_init() 函数中配置。

```c
// 定义指令集扩展配置结构体
// path: target/riscv/cpu_cfg.h
struct RISCVCPUConfig {
    bool ext_zba;
    bool ext_zbb;
    bool ext_zbc;
    bool ext_zbkb;
    bool ext_zbkc;
    bool ext_zbkx;
    bool ext_g233; /* 自定义扩展 */
}
```

## 在主板中启用新 CPU

通过前面的工作，我们已经在 QEMU 的 RISC-V CPU 模型中成功定义并注册了名为 `g233-cpu` 的新 CPU 类型。然而，定义类型只是第一步，要让我们的 CPU 真正运行起来，还需要一个明确的“启用”流程，即关联到具体的主板中，一般 virt 主板可以动态选择，其他厂商的主板一般是固定实例化某个类型的 CPU。

但流程上比较类似，我们还是以 virt 主板为例进行分析：

当 QEMU 解析到 `-cpu g33-cpu` 时，类型字符串“riscv-cpu-g33-cpu”（即 `TYPE_RISCV_CPU_G233` 的展开）会被传递给 virt 机器模型。机器初始化过程中，关键的创建步骤发生在 `RISCVHartArrayState` 对象内：

- 分配 Hart 数组：根据 `-smp` 参数，virt 机器为每个 NUMA 节点创建一个 `RISCVHartArrayState` 对象，每个对象内部管理一组 hart。

- 动态创建 CPU 实例：对于需要创建的每一个 hart，`RISCVHartArrayState` 会调用 `object_new(“riscv-cpu-g33-cpu”)`。

    `object_new()` 是 QOM 的核心函数，它根据类型名在已注册的类型系统中查找对应的 `TypeInfo`，然后分配内存并初始化一个该类型的对象实例。

    此处，类型 `riscv-cpu-g33-cpu` 对应的 `TypeInfo` 已在 `riscv_cpu_type_infos[]` 中注册，其 `instance_init` 函数（例如 `g233_cpu_init`）会被调用，完成对该 `RISCVCPU` 对象 `env` 和 `cfg` 的初步设置。

- 应用默认配置：新创建的 `RISCVCPU` 实例会从其关联的 `RISCVCPUClass.def` （即我们定义的 `g233_cpu_def` 静态结构体）中，将默认的配置（如 `misa` 扩展位图、`priv_ver` 等）拷贝到实例自身的 `RISCVCPU.cfg` 中，完成 CPU 的初始化。

- 挂载到对象树：最终，这些 `RISCVCPU` 实例作为子对象被挂载到 `RISCVHartArrayState` 及更上层的 `RISCVVirtState`（机器对象）之下，形成我们在 `info qom-tree` 命令中看到的层次化对象树。

![QEMU CPU Model for virt Machine](../../../../image/qemu-cpu-model-for-virt.png)

这个过程也完美体现了 QOM“一次定义，多处使用”的设计哲学。CPU 模型的开发者只需要关注“定义类型”，而平台集成者或最终用户则通过简单的命令行参数“启用类型”。只要类型名正确注册，QEMU 的对象系统就会自动将其集成到任何支持该架构的机器模型中，包括 `virt`、`spike` 或 `sifive_u` 等。

[1]: https://github.com/plctlab/writing-your-first-riscv-simulator/blob/main/S01E07-CPU-Simulation-Part1-in-Qemu.pdf
