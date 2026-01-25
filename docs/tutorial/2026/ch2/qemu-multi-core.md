# QEMU 多核模拟：多线程与 NUMA/UMA 架构

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

QEMU 在系统模式下模拟“多核 CPU”时，核心思想是：**把每个逻辑 CPU 抽象成一个 vCPU，并为其建立执行上下文与线程模型**。本章节将介绍：

1. `-smp` 如何定义 CPU 拓扑（NUMA/UMA）；
2. vCPU 如何创建，以及线程模型如何选择；
3. MTTCG 与单线程轮转的差异与影响；

## 基本概念

- **vCPU**：QEMU 内部用 `CPUState` 表示一个逻辑 CPU，它包含寄存器状态、运行标志、线程指针等。
- **CPU 拓扑**：`-smp` 参数定义 sockets/cores/threads 等层级，决定“逻辑 CPU 的编号与结构”。
- **加速器（accel）**：负责 vCPU 的执行方式。TCG 纯软件模拟可以单线程轮转，也可以 MTTCG 多线程；KVM/HVF 等则运行在内核或平台虚拟化之上。

可以把结构理解为：

```
Machine
  └── SMP topology (sockets/cores/threads)
        └── vCPU (CPUState) x N
              └── vCPU thread(s)
```

## SMP 拓扑

在命令行中，`-smp` 决定初始 vCPU 数量与拓扑层级。QEMU 文档要求“拓扑层级乘积必须等于 maxcpus”，并允许指定 sockets/cores/threads 等字段。

QEMU 在 `hw/core/machine-smp.c` 中根据参数填充 `MachineState::smp`，并进行一致性校验：

```c
/* hw/core/machine-smp.c */
total_cpus = drawers * books * sockets * dies *
             clusters * modules * cores * threads;
maxcpus = maxcpus > 0 ? maxcpus : total_cpus;
cpus = cpus > 0 ? cpus : maxcpus;

ms->smp.cpus = cpus;
ms->smp.sockets = sockets;
ms->smp.cores = cores;
ms->smp.threads = threads;
ms->smp.max_cpus = maxcpus;

if (total_cpus != maxcpus) {
    error_setg(errp, "Invalid CPU topology: "
               "product of the hierarchy must match maxcpus: "
               "%s != maxcpus (%u)",
               topo_msg, maxcpus);
    return;
}
```

训练营里常见的写法示例：

```
-smp 4,sockets=1,cores=4,threads=1
```

这表示 1 个 socket、每个 socket 4 个 core、每 core 1 个 thread，共 4 个 vCPU。

## UMA/NUMA

在介绍实现前，先明确概念：

- **UMA（统一内存访问）**：所有 CPU 访问同一块物理内存，访问延迟与带宽基本一致，软件侧感知不到“远近节点”。
- **NUMA（非一致内存访问）**：内存被划分为多个节点，每个节点与部分 CPU 更“近”，访问本地内存更快，跨节点访问更慢。

在 QEMU 中，**UMA 可以理解为“只有一个 NUMA 节点”**。如果用户没有显式传入 `-numa`，并且机器类型没有强制启用 NUMA，QEMU 会保持单节点视图；在启用内存热插拔或特定机型配置时，QEMU 会自动创建一个 NUMA 节点并把全部内存放进去，这依旧是 UMA 语义：

```c
/* hw/core/numa.c */
if (ms->numa_state->num_nodes == 0 &&
    ((ms->ram_slots && mc->auto_enable_numa_with_memhp) ||
     (ms->maxram_size > ms->ram_size && mc->auto_enable_numa_with_memdev) ||
     mc->auto_enable_numa)) {
        NumaNodeOptions node = { };
        parse_numa_node(ms, &node, &error_abort);
        numa_info[0].node_mem = ms->ram_size;
}
```

**NUMA** 则由 `-numa node,...` 与 `-numa cpu,...` 明确描述。QEMU 解析这些参数，将 vCPU 和内存绑定到具体节点：

```c
/* hw/core/numa.c */
for (cpus = node->cpus; cpus; cpus = cpus->next) {
    CpuInstanceProperties props;
    props = mc->cpu_index_to_instance_props(ms, cpus->value);
    props.node_id = nodenr;
    props.has_node_id = true;
    machine_set_cpu_numa_node(ms, &props, &err);
}

if (node->memdev) {
    Object *o;
    o = object_resolve_path_type(node->memdev, TYPE_MEMORY_BACKEND, NULL);
    /* ... */
    numa_info[nodenr].node_mem = object_property_get_uint(o, "size", NULL);
    numa_info[nodenr].node_memdev = MEMORY_BACKEND(o);
}
```

CPU 到节点的绑定最终落在 `machine_set_cpu_numa_node()`：它会按 socket/core/thread 等拓扑字段筛选 slot 并写入 node-id：

```c
/* hw/core/machine.c */
if (props->has_socket_id && props->socket_id != slot->props.socket_id) {
    continue;
}
/* ... */
slot->props.node_id = props->node_id;
slot->props.has_node_id = props->has_node_id;
```

NUMA 的内存总量也会被校验：所有节点的 `node_mem` 之和必须等于系统 RAM：

```c
/* hw/core/numa.c */
for (i = 0; i < ms->numa_state->num_nodes; i++) {
    numa_total += numa_info[i].node_mem;
}
if (numa_total != ms->ram_size) {
    error_report("total memory for NUMA nodes (0x%" PRIx64 ")"
                 " should equal RAM size (0x" RAM_ADDR_FMT ")",
                 numa_total, ms->ram_size);
    exit(1);
}
```

从用户视角看，NUMA/UMA 的配置入口集中在 `-numa` 相关选项，[QEMU 文档][2]给出了完整参数说明与示例。

## vCPU 创建

在系统模式下，vCPU 初始化入口是 `qemu_init_vcpu()`，它会根据 `-smp` 设置线程数，并委托 accel 创建 vCPU 线程：

```c
/* system/cpus.c */
void qemu_init_vcpu(CPUState *cpu)
{
    MachineState *ms = MACHINE(qdev_get_machine());

    cpu->nr_threads =  ms->smp.threads;
    /* ... */
    cpus_accel->create_vcpu_thread(cpu);
    /* ... */
}
```

也就是说：**vCPU 线程模型不是写死的，而是由 accel 决定的**。

## TCG 模型

TCG accel 在初始化时，根据配置选择“单线程轮转 (RR)”或“多线程 (MTTCG)”：

```c
/* accel/tcg/tcg-accel-ops.c */
if (qemu_tcg_mttcg_enabled()) {
    ops->create_vcpu_thread = mttcg_start_vcpu_thread;
    ops->kick_vcpu_thread = tcg_kick_vcpu_thread;
    ops->handle_interrupt = tcg_handle_interrupt;
} else {
    ops->create_vcpu_thread = rr_start_vcpu_thread;
    ops->kick_vcpu_thread = rr_kick_vcpu_thread;
    /* ... */
}
```

### MTTCG 线程

```c
/* accel/tcg/tcg-accel-ops-mttcg.c */
void mttcg_start_vcpu_thread(CPUState *cpu)
{
    /* ... */
    /* create a thread per vCPU with TCG (MTTCG) */
    snprintf(thread_name, VCPU_THREAD_NAME_SIZE, "CPU %d/TCG",
             cpu->cpu_index);

    qemu_thread_create(cpu->thread, thread_name, mttcg_cpu_thread_fn,
                       cpu, QEMU_THREAD_JOINABLE);
}
```

MTTCG 的设计目标是“每个 vCPU 由独立线程执行”，减少轮转开销，使多核宿主机能并行推进多个 vCPU。

### 单线程轮转

```c
/* accel/tcg/tcg-accel-ops-rr.c */
void rr_start_vcpu_thread(CPUState *cpu)
{
    /* ... */
    if (!single_tcg_cpu_thread) {
        /* share a single thread for all cpus with TCG */
        snprintf(thread_name, VCPU_THREAD_NAME_SIZE, "ALL CPUs/TCG");
        qemu_thread_create(cpu->thread, thread_name,
                           rr_cpu_thread_fn,
                           cpu, QEMU_THREAD_JOINABLE);
    } else {
        /* we share the thread, dump spare data */
        /* ... */
    }
}
```

这也是早期 TCG 的经典模型：一个线程轮流跑多个 vCPU，简单但扩展性差。

## 并行与同步

MTTCG 会在以下条件下启用：前后端支持多线程且没有与 `icount` 等功能冲突；如果启用 `-accel tcg,thread=single` 或 `-icount`，会回退到单线程轮转。

多线程的核心难点在于共享数据结构的同步。QEMU 的思路是：

- **热路径无锁**：如 vCPU 的 `tb_jmp_cache` 采用原子方式更新；
- **必要处加锁**：翻译块生成与跳转回填等关键路径加锁；
- **设备模型串行化**：通过 BQL 把 MMIO/设备访问串行化。

这些策略保证了“并行推进 vCPU”与“保持一致性”之间的平衡。

## 本章小结

- QEMU 的多核模拟以 vCPU 为单位，通过 `-smp` 描述拓扑。
- UMA 在 QEMU 中等价于单 NUMA 节点，NUMA 则通过 `-numa` 显式绑定 CPU 与内存。
- vCPU 线程模型由 accel 决定：TCG 可单线程轮转，也可 MTTCG 并行。
- MTTCG 提供并行执行能力，但需要锁与一致性机制配合。

!!! tip "进一步阅读"

    - [QEMU Multi-threaded TCG 文档（MTTCG 设计与并行策略）。][1]
    - [QEMU User Documentation：`-smp`、`-numa` 与 `-accel tcg,thread=single|multi` 说明。][2]

[1]: https://www.qemu.org/docs/master/devel/multi-thread-tcg.html
[2]: https://www.qemu.org/docs/master/system/qemu-manpage.html
