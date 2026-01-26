# GPGPU 原理介绍

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

GPGPU（General-Purpose GPU）把 GPU 从“图形渲染器”变成“通用并行计算器”。它靠大量并行线程隐
藏内存延迟，用吞吐量换取响应时间，是与 CPU 完全不同的设计哲学。

本文的目的在于提供一个理解 GPGPU 的全局视角与知识背景，但重心是关注如何在 QEMU 上集成或建模
GPGPU，用于深入学习 GPGPU 体系结构相关内容。

!!! tip "概览"

    - 执行模型：SIMD→SIMT→MIMD 与线程/块/网格组织
    - 内存层次与性能瓶颈：寄存器/共享/全局，关注访存与分支发散
    - 执行流程：CPU 侧调度与数据拷贝
    - 多节点互联与 ASIC 加速：RDMA 扩展与矩阵加速单元
    - 开源 GPGPU：Vortex 研究平台
    - GPGPU-Sim：在 CPU 上模拟 CUDA/OpenCL
    - QEMU 集成：PCIe 前端 + cmodel 后端

## 执行模型

本节涉及三类并行执行模型：SIMD、SIMT、MIMD，以下按 SIMD→SIMT→MIMD 的顺序说明。

**SIMD：** SIMD（Single Instruction, Multiple Data）更接近向量架构：一条指令对多个数据元素锁步执行。它能在规则的数据并行负载上提供更直接的硬件并发，但通常要求数据布局对齐、连续以保持向量通道充分利用。相较 SIMT，SIMD 的向量宽度对编译器或程序员更“可见”。

SIMD 伪代码示例（向量加法，向量宽度=4）：

```
v0 = load a[i : i+4]
v1 = load b[i : i+4]
v2 = v0 + v1
store c[i : i+4] = v2
```

SIMD 示意图：

```
      vadd
       |
  +----+----+----+----+
  | L0 | L1 | L2 | L3 |
  +----+----+----+----+
   a0   a1   a2   a3
```

**SIMT：** GPU 的常见执行模型是 SIMT（Single Instruction, Multiple Threads）。线程被组织为线程块（block），多个 block 组成网格（grid）。在硬件上，线程块会被分派到流式多处理器（SM），并被切分成固定大小的执行单元（warp）。

从编程视角看，SIMT 把每个线程当作独立的标量程序（各自寄存器与程序计数器），硬件将线程分组成 warp，对整个 warp 发射同一条指令；当出现分支发散时，用掩码屏蔽不活跃线程并在后续点重新汇合。因此 SIMT 在语义上更接近标量编程，但执行上具备向量化的锁步特征。

SIMT 伪代码示例（向量加法）：

```
kernel add(a, b, c):
    tid = thread_id()
    c[tid] = a[tid] + b[tid]
```

!!! tip "关键点"

    - 一个 warp 中的线程执行同一条指令，数据不同。
    - warp 通常由 32 个线程组成（常见实现）。
    - 当同一 warp 内发生分支分歧，会导致 **warp divergence**，执行路径被串行化。

SIMT 示意图：

```
        +--------------------+
Instr-> |      Warp(32)      |
        +--------------------+
             |   |   |   |
             v   v   v   v
          +-----+-----+-----+-----+
          | T0  | T1  | T2  | T3  | ...
          +-----+-----+-----+-----+

    if (cond) { A } else { B }
         |               |
      [A path]        [B path]
        T0,T2          T1,T3
     (serial replay under mask)
```

**MIMD：** MIMD（Multiple Instruction, Multiple Data）允许不同核执行不同指令流，适合任务级并行与控制流差异较大的负载。即便运行相同程序，各核也能独立走不同分支。多核 CPU、分布式集群更接近 MIMD 风格，而 GPU 更偏向在数据并行场景下用 SIMT 放大吞吐。

在 MIMD 类体系里，Tenstorrent 的产品是值得关注的代表之一。以 Wormhole 系列 PCIe 加速卡为例，它采用由 Tensix Cores 组成的多核阵列，片上集成网络互连（NoC）、本地缓存与轻量级 RISC-V 控制核，强调“多核独立调度 + 高带宽互联”的吞吐模型。官方资料也提到其支持多卡网格化互联与开放软件栈，这种形态更接近“多核并行处理器”而非传统 SIMT GPU，有利于在不同工作负载上探索更灵活的控制流与数据流组织方式。

MIMD 示意图：

```
+---------+     +---------+     +---------+     +---------+
| Core0   |     | Core1   |     | Core2   |     | Core3   |
| Prog P  |     | Prog P  |     | Prog P  |     | Prog P  |
| Data0   |     | Data1   |     | Data2   |     | Data3   |
+---------+     +---------+     +---------+     +---------+
    |               |               |               |
   if              if              if              if
    |               |               |               |
  Path A         Path B          Path A          Path B
 (runs)         (runs)          (runs)          (runs)

(same program, independent control flow)
```

## 内存层次

GPU 的性能很大程度上由内存层次决定。常见层次如下（从快到慢）：

- **寄存器**：每个线程私有，延迟最低。
- **共享内存**：同一 block 内共享，适合做数据复用。
- **L1/L2 缓存**：缓存全局访问。
- **全局内存**：容量大、延迟高，常见实现是 HBM（高带宽内存），带宽大但仍受访存模式影响。
- **主机内存**：通过 PCIe/CXL 访问，延迟更高。

优化的经验法则：尽量让访问“对齐且合并”，并使用共享内存减少全局访存。

HBM 示意：

```
  +---------+      +------------------+
  |   SMs   | <--> |  HBM Stacks/MC   |
  +---------+      +------------------+
         (high bandwidth, sensitive to access pattern)
```

## 执行流程

一个典型的 GPGPU 执行流程是：

1. CPU 分配并初始化数据。
2. 数据从主机内存拷贝到设备内存。
3. CPU 发起 kernel 调度（指定 grid/block）。
4. GPU 执行 kernel，并在 SM 上调度 warps。
5. 结果拷回主机内存并同步。

这解释了为什么“拷贝开销”常常成为瓶颈：**GPU 很快，但数据搬运慢。**

!!! tip "性能要点"

    - **并行度**：保证足够多的线程块占满 SM。
    - **分支发散**：同一 warp 内尽量走同一路径。
    - **访存合并**：连续地址的线程一起访问全局内存。
    - **数据复用**：优先放进共享内存或寄存器。

## 多节点互联

多节点互联（如 RDMA）可以把 GPU 扩展到集群规模。RDMA 让数据绕过 CPU 大量参与，减少拷贝与上下文切换，使多机间 GPU 数据交换更高效。常见形态包括 GPU <-> NIC 直连、GPU 之间通过高速网络交换数据。

RDMA 示意：

```
Node A                  Node B
+-------+   RDMA   +-------+
| GPU   | <------> | GPU   |
| NIC   |          | NIC   |
+-------+          +-------+
   (zero/low copy, low CPU overhead)
```

超节点方案通常先在单机内用更高带宽的互联把多块 GPU 组成一组“局部岛”，再通过 RDMA 把多个超节点连接起来，兼顾节点内吞吐与跨节点扩展性。

融合示意：

```
+--------------------+    +-----------+    +--------------------+
| GPU GPU GPU GPU    |----| Switch/IC |----| GPU GPU GPU GPU    |
|  (local fabric)    |    |  (fabric) |    |  (local fabric)    |
+--------------------+    +-----------+    +--------------------+
         RDMA/IB                   |                 RDMA/IB
      (inter-node)              routing          (inter-node)
```

在超节点与跨节点互联中，交换机与交换芯片承担“路由与交换站”的角色：把多节点流量汇聚、分发，并提供低延迟与拥塞控制。常见实现包括节点内的 NVLink/NVLink Switch 级别互联，以及用于 RDMA 网络的 InfiniBand 交换机，它们共同组成可扩展的互联 fabric。

## ASIC 加速

GPU 属于通用并行处理器，而 ASIC 加速器针对特定计算形态做了硬件专用化。以 Google TPU 为例，它是面向机器学习的 ASIC，核心由大量乘加单元组成的 **systolic array**，专注矩阵乘法吞吐。TPU 把数据从主机送入 infeed 队列，计算后写入 outfeed 队列，减少反复访存带来的瓶颈，更适合大规模矩阵运算与训练/推理流水线。

TPU 示意：

```
Host -> Infeed -> [ Systolic Array ] -> Outfeed -> Host

    +----+----+----+
    |MAC |MAC |MAC |
    +----+----+----+
    |MAC |MAC |MAC |
    +----+----+----+
    |MAC |MAC |MAC |
    +----+----+----+
```

在 GPU 侧，NVIDIA 的 **Tensor Core** 也是典型的矩阵加速单元，专门优化矩阵乘法与累加（GEMM）等运算，用于提升 AI 训练与推理吞吐。

从趋势看，DSA（Domain-Specific Accelerator，领域专用加速器）正在成为 GPGPU 体系的重要补充：在通用 GPU 上集成或外挂专用单元，针对矩阵乘、稀疏计算、注意力等固定模式做定制化加速，以更高能效完成特定负载。

## 开源 GPGPU

开源 GPGPU 代表项目之一是 **Vortex**：基于 RISC-V 的 GPGPU 平台，支持 OpenCL，常见形态是
运行在 FPGA 上的可扩展实现，适合教学与架构研究。

Vortex 的定位是开源、可定制的 GPGPU 研究平台，它以 RISC-V 为基础，通过最小化 ISA 扩展实现
 SIMT 执行模型，并让 OpenCL 程序能够在其上运行。论文描述该设计用尽量小的指令扩展覆盖 warp 级
执行控制与线程掩码等需求，同时扩展 OpenCL 运行时以适配新的 ISA；评估部分基于 15nm 工艺假设，
并选用 Rodinia 子集基准给出性能与能效结果。

从工程视角看，Vortex 的仓库提供完整的开源栈：硬件实现、编译器/运行时，以及用于实验的脚本与示例。
它支持在 FPGA 上进行原型验证，强调可扩展与可配置，便于研究者调整并行规模、线程组织与存储层次策略，
再观察对吞吐与能效的影响。对教学而言，它是理解 SIMT、线程调度与内存访问模式的良好载体。

Vortex 示意：

```
CUDA/OpenCL App
    |
CUDA/OpenCL Runtime
    |
Vortex Driver/Runtime
    |
RISC-V ISA Ext (SIMT)
    |
Vortex Cores -> Cache/Shared -> Mem
```

## GPGPU-Sim

GPGPU-Sim 是面向体系结构研究的开源 GPGPU 模拟器。它的基本工作方式是让 CUDA/OpenCL 程序在模拟器中执行，而不是运行在真实 GPU 硬件上，从而在 CPU 上复现实验所需的执行流程。

使用时通常只需要准备应用运行所必需的最小环境，模拟器负责完成指令执行与统计输出。它常被用于教学或架构探索，例如对比不同调度策略、存储层次配置对性能的影响。

## QEMU 集成

要在 QEMU 中集成 GPGPU cmodel（仿真模型），常见思路是：

- QEMU 提供设备前端（PCIe/CXL），负责寄存器、队列与中断。
- cmodel 作为后端，接受命令并模拟执行，返回结果/延迟。
- 两者通过共享内存或 IPC 通信（socket/pipe/共享文件）。

### PCIe 路径

把 GPU 当作 PCIe 设备建模是最常见路径。QEMU 侧通常会：

- 使用 BAR 暴露 MMIO 寄存器、队列或 doorbell。
- 使用 DMA 访问客户机内存。
- 用 MSI/MSI-X 发送中断。

相关接口在 QEMU 中是标准的 PCIe 设备模型：

```c
/* include/hw/pci/pci.h */
void pci_register_bar(PCIDevice *pci_dev, int region_num,
                      uint8_t attr, MemoryRegion *memory);
```

```c
/* include/system/dma.h */
MemTxResult dma_memory_read(AddressSpace *as, dma_addr_t addr,
                            void *buf, dma_addr_t len, MemTxAttrs attrs);
MemTxResult dma_memory_write(AddressSpace *as, dma_addr_t addr,
                             const void *buf, dma_addr_t len, MemTxAttrs attrs);
```

示意流程：

```
Guest driver -> MMIO doorbell -> QEMU PCIe device
              -> DMA read/write guest memory
              -> cmodel executes -> IRQ/MSI back
```

### CXL 路径

CXL 提供更紧密的内存语义，适合“内存扩展 + 计算”的协同建模。QEMU 中包含 CXL Type 3 设备
框架，可用于内存扩展设备：

```c
/* include/hw/cxl/cxl_device.h */
#define TYPE_CXL_TYPE3 "cxl-type3"
MemTxResult cxl_type3_read(PCIDevice *d, hwaddr host_addr, uint64_t *data,
                           unsigned size, MemTxAttrs attrs);
MemTxResult cxl_type3_write(PCIDevice *d, hwaddr host_addr, uint64_t data,
                            unsigned size, MemTxAttrs attrs);
```

在这条路径上，你可以把 cmodel 作为“后端内存设备”，让 CXL 读写进入模拟器，从而评估带宽/延迟
对 GPU 程序的影响。

### CXLMemSim

CXLMemSim 是一个纯软件的 CXL.mem 模拟器，用于性能评估。它的仓库里包含 `qemu_integration`
相关内容，提供了把 CXL 设备挂载到 QEMU 的脚本与示例。其思路是：

- QEMU 提供 CXL 设备前端（Type 3 内存设备或相关扩展）。
- 模拟器在后端实现内存延迟/带宽模型。
- 通过 QEMU 配置把 CXL 设备连接到 guest。

该项目也展示了基于 CXL 的 GPU 访问示意（CXL Type 2 路径），体现了“CPU/GPU 协同 + 高速总线”
的集成方向。我们在项目阶段会进行详细介绍。

## 本章小结

GPGPU 的核心是 SIMT 并行与层次化内存，性能瓶颈多来自分支发散与访存。QEMU 集成时，PCIe 更
通用、CXL 更贴近内存语义。以 CXLMemSim 为例，可以把 QEMU 作为前端、cmodel 作为后端，
在 PCIe/CXL 总线上完成 GPGPU 仿真的训练级闭环。
