# GPGPU Kernel 下发与执行：从 Guest OS 到 QEMU 模型

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

GPGPU 的“算子”通常对应 GPU 端的 kernel。本文从 kernel 下发与执行的通用流程切入，再结合 QEMU 的 system mode 解释如何模拟 Guest OS、PCIe 设备与 GPGPU 模型，最后给出“算子下发执行”的可实现路径。

!!! tip "概览"

    - Kernel 下发链路：API → Runtime → Driver → Command Queue → Doorbell
    - Kernel 执行与调度：Grid/Block/Warp 与分支发散
    - QEMU system mode 的 Guest OS 运行与设备模型边界
    - PCIe 设备模拟：BAR/MMIO、DMA、MSI-X
    - GPGPU 模型的前后端分层与算子执行路径
    - 参考模拟器：GPGPU-Sim / Multi2Sim / MGPUSim / HetGPU

## Kernel 下发与执行流程

在 CUDA/OpenCL 这类编程模型中，kernel 下发通常遵循下面的“主机 → 设备”链路：

1. 应用调用 kernel launch API（例如配置 grid/block、传入参数）。
2. Runtime 组装 launch 参数与 kernel 元数据（参数缓冲、代码指针、资源需求）。
3. Driver 将命令写入设备可见的 command queue（常见为环形队列）。
4. Driver 通过 MMIO 写 doorbell/队列指针，通知设备拉取新命令。
5. 设备通过 DMA 读取命令与参数，构造执行上下文并开始调度。
6. kernel 运行完成后写回完成标记，并触发中断/事件回调。

数据搬运与 kernel 执行通常分开排队：H2D/D2H 的拷贝与 kernel launch 都是队列中的“命令”，设备按顺序或依赖关系执行。

## Kernel 执行与调度要点

典型的 GPGPU 执行模型会把 kernel 组织为 **Grid → Block → Warp/Wavefront** 的层级结构。核心要点包括：

- **Block 调度**：块级任务被分派到 SM/CU 上执行，SM/CU 数量决定并行上限。
- **Warp/Wavefront 锁步执行**：同一 warp 内线程执行同一条指令，分支会造成发散与掩码执行。
- **同步与内存访问**：block 内可用 barrier 同步；访存模式决定带宽利用率。

在仿真时，调度器、访存与执行模型的细节会显著影响性能评估结果，这也是学术模拟器强调“架构细节建模”的原因之一。

## QEMU 中模拟 GPGPU 设备

在 QEMU system mode 下，Guest OS 像运行在真实机器上一样加载驱动，通过 PCIe 访问设备。对 GPGPU 而言，可行的模拟分层如下：

```
Guest App/Runtime
        |
Guest Driver (PCIe)
        |
   MMIO / DMA
        |
QEMU PCIe Device Model
        |
  GPGPU 模型/仿真器
```

**PCIe 设备模型的关键点：**

- **BAR/MMIO**：用 BAR 暴露控制寄存器、doorbell、队列指针等。
- **DMA 访问**：从 guest 物理内存读取命令与参数缓冲，并写回结果。
- **MSI/MSI-X**：kernel 完成后触发中断，通知 guest 驱动。

这部分通常由 QEMU 的 PCIe 设备模型与 DMA API 完成，重点是模拟“设备行为”，而非真实硬件时序。

## 在 QEMU 中处理算子下发执行

一种可实现的路径是把系统拆成“设备前端 + GPGPU 模型后端”：

1. **前端（QEMU 设备）**
   解析 guest 写入的 command queue，提取 kernel 元数据（代码指针、参数、grid/block 等），把任务提交给后端模型。

2. **后端（GPGPU 模型）**
   以功能级或时序级方式执行 kernel，产出统计与执行结果。

3. **完成与回写**
   前端根据后端结果写回完成标记/事件队列，并触发 MSI/MSI-X。

一个简化的事件流如下：

```
guest driver: write descriptors -> ring
guest driver: mmio doorbell
qemu device : dma read -> parse -> submit
gpgpu model : execute kernel -> finish
qemu device : dma write completion -> irq
```

如果后端使用学术模拟器（如 HetGPU/GPGPU-Sim/Multi2Sim/MGPUSim），可把 QEMU 前端当作“命令接入层”，模型当作“执行引擎”，从而在 QEMU 中复现实验所需的算子下发与执行流程。

!!! tip "进一步阅读"

    [HetGPU: A Framework for Heterogeneous GPU Simulation (IISWC 2015)](https://synergy.cs.vt.edu/pubs/HetGPU_IISWC15.pdf)

    [Analyzing CUDA Workloads Using a Detailed GPU Simulator (ISPASS 2009)](https://people.ece.ubc.ca/aamodt/papers/gpgpusim.ispass09.pdf)

    [Multi2Sim: A Simulation Framework for CPU-GPU Computing (PACT 2012)](http://www.multi2sim.org/publications/pact-2012.pdf)

    [MGPUSim: Enabling Multi-GPU Performance Modeling and Optimization (ISCA 2019)](https://people.bu.edu/joshi/files/mgpusim-isca2019.pdf)

