# QEMU CPU 建模流程：以 RISC-V 为例

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

在 QEMU 中为 RISC-V 架构添加一个新的 CPU 模型，其核心是建立在 QOM（QEMU Object Model）框架 之上的。整个建模过程遵循 QEMU 设备模型的通用范式，但融入了 RISC-V 特有的扩展管理、多核拓扑和特权级架构。比如 QEMU RISC-V 包含了一个 RISCVCPUConfig 数据结构，允许为不同类型的 CPU，绑定对应的扩展，极大地的提高了灵活性和可维护性。

下面给出一个 QOM 与 RISC-V 的关系图（摘自 [PLCT Lab · 从零开始的 RISC-V 模拟器开发][1]）

```bash
                                                                                   +--------------------------+
                                                                                   | TYPE_RISCV_CPU_MAX       |
                                                                                   +--------------------------+
  cpu base type                                                                    | TYPE_RISCV_CPU_BASE32    |
+---------------+    +---------------+   +-------------+     +----------------+    +--------------------------+
|  TYPE_OBJECT  +--->|  TYPE_DEVICE  +-->|   TYPE_CPU  +---->| TYPE_RISCV_CPU +--> | TYPE_RISCV_CPU_SHAKTI_C  |
+---------------+    +---------------+   +-------------+     +----------------+    +--------------------------+
                                                                                   | TYPE_RISCV_CPU_VEYRON_V1 |
  cpu class (interface)                                                            +--------------------------+
+---------------+    +---------------+   +-------------+     +----------------+    | TYPE_RISCV_CPU_HOST      |
|  ObjectClass  +--->|  DeviceClass  +-->|   CPUClass  +---->| RISCVCPUClass  |    +--------------------------+
+---------------+    +---------------+   +-------------+     +----------------+

  cpu object (property)
+---------------+    +---------------+   +-------------+   +-------------------+
|  Object       +--->|  DeviceState  +-->|   CPUState  +-->|  RISCVCPU(ArchCPU)|
+---------------+    +---------------+   +-------------+   +-------------------+
```



## 添加新 CPU 类型

添加一个新的 CPU 类型，并不复杂，只需要定义好这个 CPU 的类型，一般是用 C 宏封装的字符串（CPU 的型号名称）。

然后为这个 CPU 创建一个 Class(Typeinfo)，但多数情况下，这个 Class 是按照 CPU 所属的体系结构来定义的，
不需要额外为这个 CPU 从头定义一个 Class，而是直接继承体系结构对应的 Class。

最后为这个 CPU 增加一个 object 实例，就完成了这个 CPU 类型的添加。

我们来看看如何从代码层面实现：

```c
// step1 添加 CPU 类型
// path: target/riscv/cpu-qom.h
#define TYPE_RISCV_CPU_ZEVORN2333       RISCV_CPU_TYPE_NAME("zevorn-2333")


// step2 添加 CPU Class(Typeinfo)
// path: target/riscv/cpu.c

#define DEFINE_VENDOR_CPU(type_name, misa_mxl_max, initfn)  \
    {                                                       \
        .name = (type_name),                                \
        .parent = TYPE_RISCV_VENDOR_CPU,                    \
        .instance_init = (initfn),                          \
        .class_init = riscv_cpu_class_init,                 \
        .class_data = GUINT_TO_POINTER(misa_mxl_max)        \
    }

static const TypeInfo riscv_cpu_type_infos[] = {
    ...
    DEFINE_VENDOR_CPU(TYPE_RISCV_CPU_SIFIVE_E51, MXL_RV64,  rv64_sifive_e_cpu_init),
    {...
}

static void rv64_sifive_e_cpu_init(Object *obj)
{
    CPURISCVState *env = &RISCV_CPU(obj)->env;
    RISCVCPU *cpu = RISCV_CPU(obj);

    riscv_cpu_set_misa_ext(env, RVI | RVM | RVA | RVC | RVU);
    env->priv_ver = PRIV_VERSION_1_10_0;
#ifndef CONFIG_USER_ONLY
    set_satp_mode_max_supported(cpu, VM_1_10_MBARE);
#endif

    /* inherited from parent obj via riscv_cpu_init() */
    cpu->cfg.ext_zifencei = true;
    cpu->cfg.ext_zicsr = true; /* 启用某些扩展 */
    cpu->cfg.pmp = true;
}

// step3 注册 CPU 类型
DEFINE_TYPES(riscv_cpu_type_infos)
```

## 添加指令集扩展

指令集扩展通过 RISCVCPUConfig 结构体来配置，每个扩展对应一个 bool 类型的成员变量。

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
    bool ext_zevorn2333; /* 自定义扩展 */
}
```


[1]: https://github.com/plctlab/writing-your-first-riscv-simulator/blob/main/S01E07-CPU-Simulation-Part1-in-Qemu.pdf
