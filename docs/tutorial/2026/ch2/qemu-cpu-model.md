# QEMU CPU 建模流程：以 RISC-V 为例

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn) [@Plucky923](https://github.com/Plucky923)

!!! info “QEMU 版本”

    本文基于 QEMU **v10.2.0**（tag: [`v10.2.0`](https://gitlab.com/qemu-project/qemu/-/tags/v10.2.0)，commit: `75eb8d57c6b9`）。

在 QEMU 中理解或新增一个 RISC-V CPU 型号，最好不要把注意力只放在某一个文件上。按照源码实现，主要涉及下面 4 个内容：

- QOM 类型系统：CPU 作为什么类型注册到 QEMU 对象模型中。
- 模型默认值：某个 CPU 型号默认开启哪些扩展、采用哪个特权规范版本、支持哪种地址转换模式。
- CPU 实例状态：这些默认值最后如何落到 `RISCVCPU` 对象的 `env` 和 `cfg` 上。
- 主板集成：机器模型怎样根据 `-cpu`、`-smp`、`-numa` 去实例化真正的 hart。

RISC-V 这套实现的核心结构有四个：

- `RISCVCPU`：具体 CPU 实例，对应一个 hart。
- `RISCVCPUClass`：CPU 类型对应的类对象，其中保存着该型号的默认定义。
- `RISCVCPUDef`：某个 CPU 型号的默认”蓝图”。
- `RISCVCPUConfig`：扩展开关和数值型配置项，最终保存在 CPU 实例里。

!!! tip "概览"

    - RISC-V CPU 模型在 QEMU 初始化链路中的位置
    - 当前源码中的 RISC-V CPU 类型层次
    - 当前源码中新增一个 CPU 型号的真实流程
    - 当前源码中新增一个 ISA 扩展的真实流程
    - `virt` 主板如何根据 `-cpu`、`-smp`、`-numa` 实例化 hart

## 整体分析

从初始化顺序看，RISC-V CPU 模型大致处在下面这条链路中：

```text
QEMU 命令行
(-M virt -cpu ... -smp ... -numa ...)
        ↓
system/vl.c 解析机器类型和 CPU 选项
        ↓
MachineState.cpu_type 确定当前机器要使用的 CPU 型号
        ↓
板级代码创建一个或多个 RISCVHartArrayState
        ↓
每个 RISCVHartArrayState 实例化若干 RISCVCPU
        ↓
riscv_cpu_init() 把 RISCVCPUClass.def 的默认值写入实例
        ↓
CPU realize / accelerator 相关初始化
        ↓
进入运行阶段，执行翻译、异常、中断、CSR 等逻辑
```

这一点很重要：在当前 RISC-V 实现里，“CPU 型号定义”和“CPU 实例创建”是两回事。

- `target/riscv/cpu.c` 负责定义“有哪些 CPU 型号、每个型号的默认配置是什么”。
- `hw/riscv/*.c` 里的板级代码负责决定“创建多少个 hart、这些 hart 如何分组、每个 hart 用什么 CPU 型号”。

另外，也不能简单地把 RISC-V 板卡理解成“永远只支持同构 CPU”。`virt` 和 `spike` 这种机器通常会按同一种 `cpu_type` 批量创建 hart；但像 `sifive_u`、`microchip_pfsoc` 这类 SoC，在源码里本来就会创建多个 cluster，而且不同 cluster 可以使用不同的 CPU 类型。

## RISC-V CPU 的类型层次

当前源码中的 RISC-V CPU 继承关系，大致可以概括为：

```text
TYPE_CPU
  └─ TYPE_RISCV_CPU
       ├─ TYPE_RISCV_DYNAMIC_CPU
       │    ├─ TYPE_RISCV_CPU_MAX
       │    ├─ TYPE_RISCV_CPU_BASE32
       │    ├─ TYPE_RISCV_CPU_BASE64
       │    └─ TYPE_RISCV_CPU_BASE128
       ├─ TYPE_RISCV_VENDOR_CPU
       │    ├─ TYPE_RISCV_CPU_IBEX
       │    ├─ TYPE_RISCV_CPU_SHAKTI_C
       │    ├─ TYPE_RISCV_CPU_THEAD_C906
       │    ├─ TYPE_RISCV_CPU_VEYRON_V1
       │    ├─ TYPE_RISCV_CPU_XIANGSHAN_NANHU
       │    └─ TYPE_RISCV_CPU_G233
       └─ TYPE_RISCV_BARE_CPU
            ├─ TYPE_RISCV_CPU_RV32I
            ├─ TYPE_RISCV_CPU_RV32E
            ├─ TYPE_RISCV_CPU_RV64I
            └─ TYPE_RISCV_CPU_RV64E
```

从数据结构角度看，最值得记住的是下面这几层关系：

- `RISCVCPUClass` 里有一个 `RISCVCPUDef *def`，表示这个 CPU 类型的默认配置。
- `RISCVCPU` 实例里有 `CPURISCVState env` 和 `RISCVCPUConfig cfg`。
- 创建实例时，`riscv_cpu_init()` 会把 `RISCVCPUClass.def` 里的默认值合并到实例上。

也就是说，QOM 类型负责“分类”，`RISCVCPUDef` 负责“默认值”，而 `RISCVCPU` 才是运行时真正参与执行的对象。

## 当前源码中如何定义一个新 CPU 型号

如果要按照当前源码的方式新增一个 RISC-V CPU 型号，重点不再是手写一个专门的 `class_init()`，而是把新型号注册进 `riscv_cpu_type_infos[]` 这张表，并通过 `class_data` 提供 `RISCVCPUDef`。

### 第 1 步：定义用户可见型号对应的 QOM 类型名

首先需要在 `target/riscv/cpu-qom.h` 中增加一个类型宏：

```c
// path: target/riscv/cpu-qom.h
#define TYPE_RISCV_CPU_G233 RISCV_CPU_TYPE_NAME("g233-cpu")
```

这里容易混淆的一点是：

- 用户在命令行里写的是 `-cpu g233-cpu`；
- QOM 内部真正查找的类型名是 `g233-cpu-riscv-cpu`。

这是因为 `RISCV_CPU_TYPE_NAME(name)` 会把 `name` 和后缀 `-riscv-cpu` 拼接起来。

### 第 2 步：把新型号加入 `riscv_cpu_type_infos[]`

当前源码里，RISC-V CPU 型号主要通过 `DEFINE_RISCV_CPU()` 这个宏加入 `target/riscv/cpu.c` 中的 `riscv_cpu_type_infos[]`：

```c
// path: target/riscv/cpu.c
DEFINE_RISCV_CPU(TYPE_RISCV_CPU_G233, TYPE_RISCV_VENDOR_CPU,
    .misa_mxl_max = MXL_RV64,
    .misa_ext = RVI | RVM | RVA | RVC | RVU,
    .priv_spec = PRIV_VERSION_1_12_0,
    .vext_spec = VEXT_VERSION_1_00_0,
    .cfg.ext_xg233 = true,
    .cfg.ext_zicsr = true,
    .cfg.ext_zifencei = true,
    .cfg.mmu = true,
    .cfg.pmp = true,
    .cfg.max_satp_mode = VM_1_10_SV39,
),
```

这里实际上已经把“CPU 型号定义”表达清楚了：

- 它继承自哪个抽象父类型，这里是 `TYPE_RISCV_VENDOR_CPU`；
- 它默认支持哪种位宽，这里是 `RV64`；
- 它默认打开哪些单字母 MISA 扩展；
- 它的特权规范版本和向量规范版本；
- 它在 `RISCVCPUConfig` 中默认打开哪些多字母或厂商扩展；
- 它支持的最大 `satp` 模式。

### 第 3 步：理解 `DEFINE_RISCV_CPU()` 背后到底做了什么

`DEFINE_RISCV_CPU()` 并不是简单插入一个字符串，它本质上是在 `TypeInfo` 里构造一个带 `class_data` 的条目。这个 `class_data` 就是一份匿名的 `RISCVCPUDef`：

```c
// path: target/riscv/cpu.c
#define DEFINE_RISCV_CPU(type_name, parent_type_name, ...)  \
    {                                                       \
        .name = (type_name),                                \
        .parent = (parent_type_name),                       \
        .class_data = &(const RISCVCPUDef) {                \
             .priv_spec = RISCV_PROFILE_ATTR_UNUSED,        \
             .vext_spec = RISCV_PROFILE_ATTR_UNUSED,        \
             .cfg.max_satp_mode = -1,                       \
             __VA_ARGS__                                    \
        },                                                  \
    }
```

### 第 4 步：默认值如何从父类型继承下来

类型注册之后，真正负责“把父类默认值和当前型号默认值合并起来”的函数是 `riscv_cpu_class_base_init()`：

```c
// path: target/riscv/cpu.c
static void riscv_cpu_class_base_init(ObjectClass *c, const void *data)
{
    RISCVCPUClass *mcc = RISCV_CPU_CLASS(c);
    RISCVCPUClass *pcc = RISCV_CPU_CLASS(object_class_get_parent(c));

    if (pcc->def) {
        mcc->def = g_memdup2(pcc->def, sizeof(*pcc->def));
    } else {
        mcc->def = g_new0(RISCVCPUDef, 1);
    }

    if (data) {
        const RISCVCPUDef *def = data;
        ...
        mcc->def->misa_ext |= def->misa_ext;
        riscv_cpu_cfg_merge(&mcc->def->cfg, &def->cfg);
    }
}
```

- 先复制父类型的 `RISCVCPUDef`；
- 再把当前型号在 `class_data` 里给出的字段 merge 进去；
- 最终得到这个具体 CPU 类型对应的 `RISCVCPUClass.def`。

因此，选择父类型非常重要。比如：

- 继承 `TYPE_RISCV_DYNAMIC_CPU`，会得到更偏“通用可配置 CPU”的默认行为；
- 继承 `TYPE_RISCV_VENDOR_CPU`，更适合厂商型号；
- 继承 `TYPE_RISCV_BARE_CPU`，则更适合极简、近似裸机的 CPU 型号。

### 第 5 步：实例化时如何把默认值写入 `RISCVCPU`

当某个具体 CPU 对象真的被创建出来时，调用的是通用实例初始化函数 `riscv_cpu_init()`：

```c
// path: target/riscv/cpu.c
static void riscv_cpu_init(Object *obj)
{
    RISCVCPUClass *mcc = RISCV_CPU_GET_CLASS(obj);
    RISCVCPU *cpu = RISCV_CPU(obj);
    CPURISCVState *env = &cpu->env;

    env->misa_mxl = mcc->def->misa_mxl_max;
    env->misa_ext_mask = env->misa_ext = mcc->def->misa_ext;
    riscv_cpu_cfg_merge(&cpu->cfg, &mcc->def->cfg);

    if (mcc->def->priv_spec != RISCV_PROFILE_ATTR_UNUSED) {
        cpu->env.priv_ver = mcc->def->priv_spec;
    }
    if (mcc->def->vext_spec != RISCV_PROFILE_ATTR_UNUSED) {
        cpu->env.vext_ver = mcc->def->vext_spec;
    }
    ...
}
```

所以源码里，“定义 CPU 型号”的真正结果是：

1. 在 QOM 类型系统里新增一个类型；
2. 为这个类型构造一份 `RISCVCPUClass.def`；
3. 当实例被创建时，再把这份 `def` 的内容合并到 `RISCVCPU` 实例上。


### 第 6 步：如何验证新型号已经注册成功

做完类型定义后，可以通过下面几种方式验证：

- `qemu-system-riscv64 -cpu help`：确认用户可见型号名已经出现；
- `qemu-system-riscv64 -M virt -cpu g233-cpu ...`：确认可以被板级代码正常选用；
- QEMU monitor 中观察 `info qom-tree`：确认对象树里出现了对应 CPU 实例。

## 当前源码中如何添加一个扩展


通过 `cpu_cfg_fields.h.inc` 生成：

```c
// path: target/riscv/cpu_cfg.h
struct RISCVCPUConfig {
#define BOOL_FIELD(x) bool x;
#define TYPED_FIELD(type, x, default) type x;
#include "cpu_cfg_fields.h.inc"
};
```

因此，如果你要新增一个自定义扩展 `xg233`，真正加字段的地方通常是：

```c
// path: target/riscv/cpu_cfg_fields.h.inc
BOOL_FIELD(ext_xg233)
```

非标准扩展按 RISC-V 约定应以 x 开头。

`cpu_cfg.h` 里有一组 `MATERIALISE_EXT_PREDICATE()` 宏，会为扩展生成统一的判断函数：

```c
// path: target/riscv/cpu_cfg.h
MATERIALISE_EXT_PREDICATE(xg233)
```

这样源码其他位置就可以通过统一风格去判断该扩展是否开启。对于简单扩展，这通常只是把 `cfg.ext_xg233` 包装成一个小函数；对于更复杂的扩展族，源码里也有像 `has_xmips_p()`、`has_xthead_p()` 这样的聚合判断函数。

### 扩展元数据表

如果希望扩展真正进入 RISC-V 扩展元数据体系，就需要把它加入 `isa_edata_arr[]`：

```c
// path: target/riscv/cpu.c
ISA_EXT_DATA_ENTRY(xg233, PRIV_VERSION_1_12_0, ext_xg233),
```

这一项至少表达了三件事：

- 扩展名是 `xg233`；
- 这个扩展对应的最小特权规范版本；
- 它在 `RISCVCPUConfig` 里的开关字段偏移。

这一张表会参与 ISA 扩展相关的多个流程，例如构造 ISA 字符串时，就会遍历 `isa_edata_arr[]`，把当前已经启用的多字母扩展拼进去。


仅仅把字段加进 `RISCVCPUConfig`，还不足以让用户从命令行打开它。当前源码里，多字母扩展的属性暴露主要依赖几张配置表。

对于厂商扩展，通常要加入 `riscv_cpu_vendor_exts[]`：

```c
// path: target/riscv/cpu.c
const RISCVCPUMultiExtConfig riscv_cpu_vendor_exts[] = {
    ...
    MULTI_EXT_CFG_BOOL("xg233", ext_xg233, false),
    { },
};
```

这里的作用是把扩展名 `"xg233"` 和 `RISCVCPUConfig.ext_xg233` 关联起来，使它可以作为 CPU 属性参与解析。

可以把这一步理解成：前面只是“CPU 内部知道有这个扩展”，而这里才是“把这个扩展暴露给用户配置接口”。

### 最后，给具体 CPU 型号设置默认值

扩展是否默认打开，最终还是由具体 CPU 型号决定。例如 `g233-cpu` 默认打开 `xg233`，就是在该型号对应的 `DEFINE_RISCV_CPU()` 条目里完成的：

```c
// path: target/riscv/cpu.c
DEFINE_RISCV_CPU(TYPE_RISCV_CPU_G233, TYPE_RISCV_VENDOR_CPU,
    ...
    .cfg.ext_xg233 = true,
    ...
),
```

这说明一个常被忽略的区别：

- “QEMU 支持某个扩展”是一回事；
- “某个 CPU 型号默认启用该扩展”是另一回事。

前者决定框架有没有能力识别和处理这个扩展，后者决定用户选中某个 CPU 型号时，这个扩展默认是否处于开启状态。

### 单字母扩展和多字母扩展并不完全一样

当前源码中，单字母扩展和多字母扩展并不是走完全相同的路径：

- 单字母扩展主要通过 `misa_ext` 这样的位图表示，例如 `RVI`、`RVM`、`RVA`、`RVC`；
- 多字母扩展、命名特性和厂商扩展主要通过 `RISCVCPUConfig` 里的 `ext_*` 字段表示。

所以在定义一个 CPU 型号时，经常会同时看到两类配置：

```c
.misa_ext = RVI | RVM | RVA | RVC | RVU,
.cfg.ext_zicsr = true,
.cfg.ext_zifencei = true,
.cfg.ext_xg233 = true,
```

## 在主板中启用一个 CPU 型号

前面几节解决的是“这个 CPU 型号怎样注册到 QEMU 里”。接下来要解决的问题是：“当用户写下 `-cpu g233-cpu` 时，这个型号怎样真正变成主板里的一个个 hart？”

以 `virt` 主板为例，这条链路大致可以拆成 5 步。

### 第 1 步：命令行决定 `MachineState.cpu_type`

在 `system/vl.c` 中，QEMU 会先拿到机器默认 CPU 类型；如果用户显式传了 `-cpu`，则用用户给的型号覆盖：

```c
// path: system/vl.c
current_machine->cpu_type = machine_default_cpu_type(current_machine);
if (cpu_option) {
    current_machine->cpu_type = parse_cpu_option(cpu_option);
}
```

对 RISC-V 来说，`parse_cpu_option()` 最终会通过 `riscv_cpu_class_by_name()` 把用户输入的 `g233-cpu` 映射到内部 QOM 类型名：

```c
// path: target/riscv/cpu.c
static ObjectClass *riscv_cpu_class_by_name(const char *cpu_model)
{
    ...
    typename = g_strdup_printf(RISCV_CPU_TYPE_NAME("%s"), cpuname[0]);
    oc = object_class_by_name(typename);
    ...
}
```

因此，`-cpu g233-cpu` 最终会把 `MachineState.cpu_type` 设成 `g233-cpu-riscv-cpu` 这个内部类型名。

### 第 2 步：`virt` 主板声明自己的 CPU 拓扑能力

`virt_machine_class_init()` 中可以看到，`virt` 机器会把默认 CPU 类型和 NUMA 相关的几个回调都挂到 `MachineClass` 上：

```c
// path: hw/riscv/virt.c
mc->default_cpu_type = TYPE_RISCV_CPU_BASE;
mc->possible_cpu_arch_ids = riscv_numa_possible_cpu_arch_ids;
mc->cpu_index_to_instance_props = riscv_numa_cpu_index_to_props;
mc->get_default_cpu_node_id = riscv_numa_get_default_cpu_node_id;
mc->numa_mem_supported = true;
mc->cpu_cluster_has_numa_boundary = true;
```

这说明 `virt` 主板不仅能选择 CPU 类型，还显式支持：

- `-smp` 指定的 CPU 数量和拓扑；
- `-numa` 指定的节点划分；
- CPU 到 NUMA node 的默认映射。

### 第 3 步：`-smp` 和 `-numa` 决定要创建多少 hart

在这一条链路里，有几个概念最好先区分开：

- **hart**：RISC-V 硬件线程。对当前实现而言，可以近似看成一个 `RISCVCPU` 实例。
- **`-smp`**：决定当前虚拟机要启动多少个 CPU，以及 `sockets/cores/threads` 等拓扑参数。
- **NUMA**：把 CPU 和内存划成多个 node；在 `virt` 的实现里，这会进一步影响 socket 数、hart 分组和 `mhartid` 分配。

RISC-V 的 NUMA 辅助逻辑在 `hw/riscv/numa.c` 中。例如：

```c
// path: hw/riscv/numa.c
int riscv_socket_count(const MachineState *ms)
{
    return (numa_enabled(ms)) ? ms->numa_state->num_nodes : 1;
}
```

这意味着：

- 没有启用 NUMA 时，`virt` 只会创建 1 个 socket；
- 启用 NUMA 时，socket 数量等于 NUMA node 数量。

同时，`riscv_numa_possible_cpu_arch_ids()` 会基于 `ms->smp.max_cpus` 预先生成 `possible_cpus[]`，并把每个 CPU 插槽的 `type` 设为 `ms->cpu_type`。之后，QEMU 通用 NUMA 逻辑再结合 `-numa` 去给这些 CPU 插槽分配 node。

### 第 4 步：`virt` 先创建 `RISCVHartArrayState`

`virt` 主板本身并不会直接逐个 `new` 出所有 `RISCVCPU`。它先创建的是若干个 `RISCVHartArrayState`，每个数组对象负责管理一组 hart：

```c
// path: hw/riscv/virt.c
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

这里传下去的几项信息分别是：

- `cpu-type`：这一组 hart 使用哪种 CPU 型号；
- `hartid-base`：这一组 hart 的起始 `mhartid`；
- `num-harts`：这一组里有多少个 hart。

从对象树角度看，`RISCVVirtState` 下面先挂的是 `soc0`、`soc1` 这样的 hart 数组对象，而不是直接挂若干个 CPU。

### 第 5 步：`RISCVHartArrayState` 再逐个实例化 `RISCVCPU`

真正逐个创建 CPU 的工作发生在 `hw/riscv/riscv_hart.c`：

```c
// path: hw/riscv/riscv_hart.c
static void riscv_harts_realize(DeviceState *dev, Error **errp)
{
    RISCVHartArrayState *s = RISCV_HART_ARRAY(dev);
    int n;

    s->harts = g_new0(RISCVCPU, s->num_harts);
    for (n = 0; n < s->num_harts; n++) {
        if (!riscv_hart_realize(s, n, s->cpu_type, errp)) {
            return;
        }
    }
}
```

而单个 hart 的创建逻辑是：

```c
// path: hw/riscv/riscv_hart.c
object_initialize_child(OBJECT(s), "harts[*]", &s->harts[idx], cpu_type);
qdev_prop_set_uint64(DEVICE(&s->harts[idx]), "resetvec", s->resetvec);
...
s->harts[idx].env.mhartid = s->hartid_base + idx;
return qdev_realize(DEVICE(&s->harts[idx]), NULL, errp);
```

这里可以看出几件事：

- 当前代码使用的是 `object_initialize_child()`，不是直接手写 `object_new()`；
- 每个 `RISCVCPU` 都是 `RISCVHartArrayState` 的子对象；
- `mhartid` 是在板级实例化时分配的，而不是在 CPU 型号定义时写死的。

### 这条链路最后说明了什么

把整条链路串起来看，就会更容易理解 QEMU 里“CPU 型号”和“主板使用 CPU 型号”之间的边界：

- `target/riscv/cpu.c` 负责定义 CPU 型号本身；
- `system/vl.c` 负责把 `-cpu` 解析成内部类型名；
- `hw/riscv/virt.c` 负责根据 `-smp` / `-numa` 生成 hart 分组；
- `hw/riscv/riscv_hart.c` 负责把这些分组真正展开成 `RISCVCPU` 实例；
- `riscv_cpu_init()` 再把该型号的默认配置写入实例。

所以，“在主板中启用一个新 CPU”并不意味着要在 `virt.c` 里为这个 CPU 型号添加专门分支。只要：

- 这个 CPU 型号已经正确注册到 RISC-V QOM 类型系统中；
- 板级代码允许使用这个 `cpu_type`；
- 相关扩展和属性都能被正常解析；

那么 `virt`、`spike` 或其他支持动态选择 CPU 类型的机器模型，就可以沿着这条统一流程把它实例化出来。

![QEMU CPU Model for virt Machine](../../../../image/qemu-cpu-model-for-virt.png)

这个过程体现了 QOM 的一个核心思想：CPU 型号定义一次，机器模型按需复用。模型作者主要负责“定义这个 CPU 是什么”，板级代码主要负责“决定在这个平台上创建多少个这样的 CPU、它们如何编号、如何分组”。

!!! question "随堂测验"

    [>> 【点击进入随堂测验】2-3 分钟小测，快速巩固 ☄](https://ima.qq.com/quiz?quizId=35ZeDYUSP4cQgbQwRfwff0ppExoKKq8civQPTydfR1rF)
