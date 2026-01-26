# QEMU SoftMMU：系统模式下的地址转换与内存访问

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

SoftMMU 是 QEMU 系统模式（system mode）的核心。它用软件实现了“客户机 MMU + TLB + 设备访问”的完整链路，让客户机操作系统认为自己正在访问真实硬件内存与外设。

如果你只记住一句话：**SoftMMU 负责把“客户机虚拟地址”变成“宿主机可访问的内存或设备操作”**。

!!! tip "概览"

    - SoftMMU 在 system mode 下的定位与职责
    - AddressSpace/MemoryRegion/FlatView/SoftTLB 的关系
    - GVA→GPA→HVA 的地址转换路径
    - TLB miss 与 `tlb_fill` 回调机制
    - IOMMU/DMA 与设备访问的协作路径

## SoftMMU 的定位

QEMU 官方文档里对 SoftMMU 的描述非常直接：系统模式之所以叫 softmmu，是因为它用软件实现 MMU 与 TLB（Translation Lookaside Buffer）。这也是它和 user mode 的根本差异之一：user mode 不实现完整的软 MMU，而是依赖宿主机的 MMU 与 OS 来做地址管理（直接通过 `mmap()` 来为客户机内存分配内存）。

## 关键概念（常见术语）

为了让后面的流程更清晰，我们先统一几个关键名词：

- **AddressSpace**：客户机“可见”的地址空间（如系统内存、I/O 地址空间）。
- **MemoryRegion**：QEMU 用来描述一段内存或设备映射的抽象对象，前面的章节已经详细讲过。
- **FlatView**：把 AddressSpace 中所有 MemoryRegion“摊平成”可查表的结构，便于快速翻译。
- **SoftTLB**：QEMU 在系统模式下维护的 TLB，用来缓存地址转换结果。

这几个概念一起构成了 SoftMMU 的核心数据路径。

## 地址类型与转换路径

从客户机视角看，地址至少分三类：

- **Guest Virtual Address (GVA)**：客户机进程使用的虚拟地址。
- **Guest Physical Address (GPA)**：客户机 MMU 翻译后的物理地址。
- **Host Virtual Address (HVA)**：QEMU 进程在宿主机上的虚拟地址。
- **Host Physical Address (HPA)**：宿主机 MMU 翻译后的物理地址。

这也是一条经典的软 MMU 路径：

```
GVA (guest virtual)
   └─(guest MMU, page table)→ GPA (guest physical)
         └─(SoftMMU / MemoryRegion / FlatView)→ HVA (host virtual)
```

在 system mode 下，QEMU 需要完整走完这条链路；而在 user mode 下，会跳过 SoftMMU 的第二段转换（直接依赖宿主机 MMU）。

## 一次访存发生了什么

以一次 cpu 的 load/store 操作为例，SoftMMU 的流程大致是：

1. TCG 生成的访存指令触发 SoftMMU 访问路径（通过 Helper）。
2. SoftMMU 先查 TLB（命中直接访问，未命中触发填充）。
3. TLB miss 会调用目标架构的 `tlb_fill` 回调，完成页表遍历或异常处理（调用 arch 具体实现）。
4. 翻译得到物理地址后，通过 AddressSpace/FlatView 定位 MemoryRegion。
5. 若是 RAM，直接访问宿主机内存；若是 MMIO，调用设备模型的读写回调。

下面是 SoftMMU TLB miss 的回调接口定义（节选自 `include/accel/tcg/cpu-ops.h`）：

```c
/* include/accel/tcg/cpu-ops.h */
/**
 * @tlb_fill: Handle a softmmu tlb miss
 *
 * If the access is valid, call tlb_set_page and return true;
 * if the access is invalid and probe is true, return false;
 * otherwise raise an exception and do not return.
 */
bool (*tlb_fill)(CPUState *cpu, vaddr address, int size,
                 MMUAccessType access_type, int mmu_idx,
                 bool probe, uintptr_t retaddr);
```

## 从地址到设备：FlatView

SoftMMU 在系统模式下会把 AddressSpace“拍平”成 FlatView，翻译时先在 FlatView 中做定位。
如果遇到 IOMMU，还会递归做二次翻译（见 `system/physmem.c`）：

```c
/* system/physmem.c */
static MemoryRegionSection flatview_do_translate(FlatView *fv,
                                                 hwaddr addr,
                                                 hwaddr *xlat,
                                                 hwaddr *plen_out,
                                                 hwaddr *page_mask_out,
                                                 bool is_write,
                                                 bool is_mmio,
                                                 AddressSpace **target_as,
                                                 MemTxAttrs attrs)
{
    MemoryRegionSection *section;
    IOMMUMemoryRegion *iommu_mr;

    section = address_space_translate_internal(
            flatview_to_dispatch(fv), addr, xlat,
            plen_out, is_mmio);

    iommu_mr = memory_region_get_iommu(section->mr);
    if (unlikely(iommu_mr)) {
        return address_space_translate_iommu(iommu_mr, xlat,
                                             plen_out, page_mask_out,
                                             is_write, is_mmio,
                                             target_as, attrs);
    }
    return *section;
}
```

翻译完成后，QEMU 会区分 RAM 和 MMIO。下面是 `flatview_read_continue_step` 的关键分支
（节选自 `system/physmem.c`）：

```c
/* system/physmem.c */
if (!memory_access_is_direct(mr, false, attrs)) {
    /* I/O case */
    result = memory_region_dispatch_read(mr, mr_addr, &val, size_memop(*l),
                                         attrs);
} else {
    /* RAM case */
    uint8_t *ram_ptr = qemu_ram_ptr_length(mr->ram_block, mr_addr, l,
                                           false, false);
    memcpy(buf, ram_ptr, *l);
}
```

这段逻辑很好地体现了 SoftMMU 的本质：**对 RAM 是“直接访存”，对设备是“回调访问”**。

## SoftMMU 与 IOMMU / DMA

系统模式里，DMA 访问的地址通常需要经过 IOMMU 翻译。

SoftMMU 在 `address_space_translate_iommu` 里完成 IOMMU 二次翻译，并把结果作为 DMA 的
实际访问地址。这也是为什么 QEMU 能在纯软件环境里模拟复杂的 IOMMU 行为。

## SoftMMU 总结

SoftMMU 是 QEMU system mode 的“地址转换 + 设备访问中枢”。它把客户机的虚拟地址转换为宿主机
可操作的地址，并用统一的 MemoryRegion/FlatView 把 RAM 与 MMIO 访问统一管理。理解这套流程，
对阅读 SoftMMU 代码和调试内存访问问题非常关键。

!!! tip "进一步阅读"

    - QEMU Glossary：SoftMMU 与 system mode 的官方定义。[1]
    - SoftMMU 地址转换与系统模式的通俗解释文章。[2]

[1]: https://www.qemu.org/docs/master/glossary.html
[2]: https://www.profound-dt.co.jp/qemu-en/qemu_chap4_en/
