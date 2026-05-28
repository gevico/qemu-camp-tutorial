# QEMU 训练营 2026 专业阶段总结

!!! note "主要贡献者"

    - 作者：[@vsvnakers](https://github.com/vsvnakers)

---

## 背景介绍

微电子专业在读，在校大四本科生，往计算机方向转对底层系统技术比较感兴趣。之前对 QEMU 的了解仅限于「用它启动一个虚拟机」，但对于内部的设备模型、指令翻译等机制完全没有概念。看到 QEMU 训练营有机会从源码层面深入理解一个工业级虚拟机的内部实现，觉得是一次很好的学习机会，于是报名参加了专业阶段。

---

## 专业阶段

选择的是 GPU 方向实验，任务是实现一个教育用途的 GPGPU 设备模型，通过 QTest 框架的 17 个测试用例验证正确性。实验覆盖了设备识别、全局控制、VRAM 访问、DMA 传输、中断模拟、SIMT 上下文调度、kernel 执行、低精度浮点格式转换等内容。

### 设备注册与初始化

GPGPU 是一个 PCIe 设备，首先通过 `type_init` 宏将类型注册到 QOM 系统。QOM 是 QEMU 用 C 实现的面向对象框架，设备类型遵循 `Object → Device → PCI_DEVICE → GPGPU` 的继承链：

```c
static const TypeInfo gpgpu_info = {
    .name          = TYPE_GPGPU,
    .parent        = TYPE_PCI_DEVICE,
    .instance_size = sizeof(GPGPUState),
    .class_init    = gpgpu_class_init,
};

static void gpgpu_register_types(void)
{
    type_register_static(&gpgpu_info);
}

type_init(gpgpu_register_types)
```

QEMU 命令行指定 `-device gpgpu` 时，会调用 `gpgpu_realize` 完成硬件资源分配——注册三个 BAR 空间、分配 VRAM、初始化 MSI-X：

```c
static void gpgpu_realize(PCIDevice *pdev, Error **errp)
{
    GPGPUState *s = GPGPU(pdev);

    s->vram_ptr = g_malloc0(s->vram_size);

    /* BAR0: 控制寄存器 1MB MMIO */
    memory_region_init_io(&s->ctrl_mmio, OBJECT(s), &gpgpu_ctrl_ops, s,
                          "gpgpu-ctrl", GPGPU_CTRL_BAR_SIZE);
    pci_register_bar(pdev, 0, PCI_BASE_ADDRESS_SPACE_MEMORY, &s->ctrl_mmio);

    /* BAR2: 显存 64MB MMIO */
    memory_region_init_io(&s->vram, OBJECT(s), &gpgpu_vram_ops, s,
                          "gpgpu-vram", s->vram_size);
    pci_register_bar(pdev, 2, PCI_BASE_ADDRESS_SPACE_MEMORY, &s->vram);

    /* BAR4: doorbell 64KB MMIO */
    memory_region_init_io(&s->doorbell_mmio, OBJECT(s), &gpgpu_doorbell_ops, s,
                          "gpgpu-doorbell", GPGPU_DOORBELL_BAR_SIZE);
    pci_register_bar(pdev, 4, PCI_BASE_ADDRESS_SPACE_MEMORY, &s->doorbell_mmio);

    msix_init(pdev, GPGPU_MSIX_VECTORS, ...);
}
```

Guest CPU 读写 BAR 地址时，QEMU 通过 `MemoryRegionOps` 自动调用对应回调函数，传入 BAR 内部偏移量和设备状态指针。例如 `gpgpu_ctrl_ops` 关联的 `gpgpu_ctrl_read/write` 就负责处理控制寄存器的读写。

### 内核分发与 SIMT 调度

测试用例通过 QTest 直接写 `GPGPU_REG_DISPATCH` 寄存器触发执行，整个过程无需客户机操作系统参与。核心流程按 Grid → Block → Warp 三级层次展开：

```c
int gpgpu_core_exec_kernel(GPGPUState *s)
{
    uint32_t threads_per_block = block_dim_x * block_dim_y * block_dim_z;
    uint32_t warps_per_block = (threads_per_block + 31) / 32;

    /* 遍历所有 Block */
    for (每个 block) {
        /* 遍历 Block 内的 Warp */
        for (int w = 0; w < warps_per_block; w++) {
            gpgpu_core_init_warp(&warps[w], kernel_addr, ...);
            gpgpu_core_exec_warp(s, &warps[w]);
        }
    }
}
```

每个 Warp 包含 32 个 Lane，锁步执行同一条指令。线程通过 `mhartid` CSR 获取自己的三维 ID，相当于 CUDA 的 `threadIdx + blockIdx` 被编码进一个硬件寄存器：

```c
/* mhartid 位域：[31:13] block_id  [12:5] warp_id  [4:0] lane_id */
lane->mhartid = MHARTID_ENCODE(block_id_linear, warp_id, i);
lane->gpr[11] = thread_id_base + i;  /* a1 = 线程 ID */
lane->gpr[10] = (uint32_t)kernel_args; /* a0 = 内核参数指针 */
```

### 指令译码与执行

Warp 内的 Lane 锁步执行同一个精简的 RV32I/RV32F 解释器。译码阶段从 32 位指令中提取 opcode、rd、rs1、rs2、funct3 等字段，然后用 switch-case 分发到各指令的执行逻辑：

```c
static inline void decode_and_exec(GPGPUState *s, GPGPULane *lane, uint32_t inst)
{
    uint8_t opcode = inst & 0x7F;
    uint8_t rd     = (inst >> 7)  & 0x1F;
    uint8_t rs1    = (inst >> 15) & 0x1F;
    uint8_t rs2    = (inst >> 20) & 0x1F;
    uint32_t funct3 = (inst >> 12) & 0x7;

    switch (opcode) {
    case 0x37: /* LUI */
        if (rd != 0) lane->gpr[rd] = imm_u;
        return;
    case 0x07: /* FLW - 浮点加载 */
        {
            uint32_t addr = lane->gpr[rs1] + imm_i;
            if (addr < s->vram_size) {
                uint32_t val;
                memcpy(&val, s->vram_ptr + addr, 4);
                lane->fpr[rd] = val;
            }
        }
        return;
    /* ... 其他指令 */
    }
}
```

GPU 访问 VRAM 直接通过 `memcpy` 操作 `vram_ptr`，模拟的是 GPU 核心直接访问显存的场景；而 Host 侧 DMA 数据搬运则通过 `MemoryRegionOps` 中的回调函数完成。

### 低精度浮点转换

实验中实现了 FP32 到 E2M1 格式的自定义浮点转换指令。E2M1 是一种极低精度格式，仅 4 bit，能表示 8 个正数值（0/0.5/1.0/1.5/2.0/3.0/4.0/6.0）。转换思路是取 FP32 输入绝对值的位模式（uint32_t），与各相邻 E2M1 代表值的 FP32 中点阈值做整数比较，确定所属区间：

```c
/* 区间划分：取 FP32 绝对值的位模式，与各中点阈值比较 */
if (abs_val < 0x3D800000U)       e2m1_result = 0x0; /* [0, 0.25) → 0 */
else if (abs_val < 0x3F400000U)  e2m1_result = 0x1; /* [0.25, 0.75) → 0.5 */
else if (abs_val < 0x3FA00000U)  e2m1_result = 0x2; /* [0.75, 1.25) → 1.0 */
else if (abs_val < 0x3FE00000U)  e2m1_result = 0x3; /* [1.25, 1.75) → 1.5 */
else if (abs_val < 0x40200000U)  e2m1_result = 0x4; /* [1.75, 2.5) → 2.0 */
else if (abs_val < 0x40600000U)  e2m1_result = 0x5; /* [2.5, 3.5) → 3.0 */
else if (abs_val < 0x40A00000U)  e2m1_result = 0x6; /* [3.5, 5.0) → 4.0 */
else                             e2m1_result = 0x7; /* [5.0, +∞) → 6.0 */

if (sign) e2m1_result |= 0x8; /* 加回符号位 */
```

超出最大值 6.0 的输入饱和到 6.0，NaN/Inf 同样饱和。这种低精度格式在 AI 推理场景中很常见，用 4 bit 就能完成矩阵乘法的核心计算。

### 中断通知

所有 Warp 执行完毕后，通过 MSI-X 通知 Host 执行完成。MSI-X 是 PCIe 的消息信号中断机制，设备通过写特定的内存地址来触发中断，不需要额外的中断线：

```c
/* 执行完成后触发中断 */
msix_notify(pdev, 0);
```

---

## 总结

通过 GPU 方向实验，从零走通了 QEMU PCI 设备建模的完整链路：

1. **QOM 类型注册** → `type_init` + `TypeInfo` 将设备注册到类型系统
2. **BAR 映射** → `pci_register_bar` + `memory_region_init_io` 建立地址空间
3. **MMIO 回调** → `MemoryRegionOps` 将寄存器读写桥接到设备状态
4. **SIMT 调度** → Grid/Block/Warp/Lane 四级线程层次
5. **中断通知** → MSI-X 通知 Host 执行完成

