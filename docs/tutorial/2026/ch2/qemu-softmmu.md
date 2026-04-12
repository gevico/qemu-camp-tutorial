# QEMU SoftMMU：系统模式下的地址转换与内存访问

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

!!! info "QEMU 版本"

    本文基于 QEMU **v10.2.0**（tag: [`v10.2.0`](https://gitlab.com/qemu-project/qemu/-/tags/v10.2.0)，commit: `75eb8d57c6b9`）。

QEMU 的系统模式（system mode）需要完整模拟一台计算机——包括 CPU、内存和外设。在真实硬件上，CPU 通过 MMU（Memory Management Unit）和 TLB（Translation Lookaside Buffer）完成虚拟地址到物理地址的翻译，然后由物理地址决定这次访问落到 DRAM 还是某个外设的寄存器上。QEMU 要在纯软件层面复现这套机制，这就是 SoftMMU 存在的理由——soft 意味着"用软件实现"，而非依赖宿主机的硬件 MMU。

与之对应的 user mode 不需要操心这些：它只模拟用户态指令，客户机进程的内存直接通过 `mmap()` 映射到宿主机地址空间，地址翻译交给宿主机的 OS 和硬件 MMU 处理。两种模式在内存管理上的差异，本质上就是"要不要自己实现 MMU"这一个问题。

---

!!! tip "概览"

    - SoftMMU 在 system mode 下的定位与职责
    - GVA → GPA → HVA 地址转换的完整链路
    - SoftTLB 的数据结构与组织方式
    - TCG 如何生成访存代码并对接 SoftMMU
    - TLB 快速路径与慢速路径的执行细节
    - FlatView 地址分派：RAM 直接访问 vs MMIO 回调
    - IOMMU 二次翻译与 DMA 协作
    - TLB 刷新与脏页追踪

---

## 地址层次

在系统模式下，一次内存访问会经过多层地址翻译。我们先把这几层地址理清楚：

- **GVA（Guest Virtual Address）**：客户机进程使用的虚拟地址，和我们在 Linux 上写 C 程序时用的指针值一样。
- **GPA（Guest Physical Address）**：经过客户机 MMU 翻译后的物理地址。在客户机 OS 的视角里，这就是"物理内存地址"。
- **HVA（Host Virtual Address）**：QEMU 进程在宿主机上的虚拟地址。客户机的物理内存实际上是 QEMU 通过 `mmap()` 分配的一块宿主机虚拟内存。
- **HPA（Host Physical Address）**：宿主机硬件 MMU 翻译后的真实物理地址。这一层对 QEMU 的软件逻辑是透明的。

把这四层串起来，就是系统模式下完整的地址翻译路径：

```
GVA (guest virtual address)
 │
 ├─[客户机页表遍历]──→ GPA (guest physical address)
 │                      │
 │                      ├─[SoftMMU / FlatView]──→ HVA (host virtual address)
 │                      │                         │
 │                      │                         └─[宿主机硬件 MMU]──→ HPA
 │                      │
 │                      └─[如果是 MMIO]──→ 调用设备模型的读写回调
```

SoftMMU 负责的是中间那一段：从 GPA 找到对应的 HVA（对于 RAM）或者触发设备回调（对于 MMIO）。而 GVA 到 GPA 的翻译由目标架构的页表遍历逻辑完成——在 QEMU 里，这部分实现在各架构的 `tlb_fill` 回调中。

---

## SoftTLB 的数据结构

真实 CPU 的 TLB 是硬件结构，容量有限，用于缓存最近的页表翻译结果。QEMU 的 SoftTLB 在软件层面做同样的事情——缓存 GVA 到 HVA 的翻译结果，避免每次访存都去遍历客户机页表。

SoftTLB 的设计围绕一个核心目标：**让 TLB 命中时的开销尽可能小**。为此，QEMU 把 TLB 条目拆成了两个结构——一个精简的快速路径结构，和一个包含完整信息的慢速路径结构。

---

### CPUTLBEntry：快速路径条目

`CPUTLBEntry` 是 TCG 生成的代码在内联 TLB 检查时直接访问的结构（`include/exec/tlb-common.h`）：

```c
/* include/exec/tlb-common.h */
typedef union CPUTLBEntry {
    struct {
        uintptr_t addr_read;
        uintptr_t addr_write;
        uintptr_t addr_code;
        uintptr_t addend;
    };
    uintptr_t addr_idx[(1 << CPU_TLB_ENTRY_BITS) / sizeof(uintptr_t)];
} CPUTLBEntry;
```

在 64 位系统上，这个结构正好 32 字节（4 个 `uintptr_t`）。`addr_read`、`addr_write`、`addr_code` 分别存储读、写、取指三种访问类型对应的虚拟地址匹配值。`addend` 是从虚拟地址到宿主机地址的偏移量——TLB 命中时，只需要 `addr + addend` 就能得到 HVA，这是整个快速路径的关键。

`addr_idx` 数组提供了按访问类型（`MMUAccessType`）索引的能力：`MMU_DATA_LOAD=0` 对应 `addr_read`，`MMU_DATA_STORE=1` 对应 `addr_write`，`MMU_INST_FETCH=2` 对应 `addr_code`。

---

### CPUTLBEntryFull：完整条目

快速路径不需要的信息——物理地址、访问权限、页面大小、所属的 MemoryRegion 等——全部放在 `CPUTLBEntryFull` 里（`include/hw/core/cpu.h`）：

```c
/* include/hw/core/cpu.h */
struct CPUTLBEntryFull {
    hwaddr xlat_offset;
    MemoryRegionSection *section;
    hwaddr phys_addr;
    MemTxAttrs attrs;
    uint8_t prot;
    uint8_t lg_page_size;
    uint8_t tlb_fill_flags;
    uint8_t slow_flags[MMU_ACCESS_COUNT];
    /* ... */
};
```

这样拆分的好处很明确：快速路径只访问 `CPUTLBEntry`，缓存友好；只有在 TLB miss 或者需要检查权限、处理 MMIO 等特殊情况时，才去查 `CPUTLBEntryFull`。

---

### TLB 的整体组织

每个 vCPU 维护自己独立的 TLB（`CPUTLB` 结构），按 MMU 模式（`NB_MMU_MODES`）分别管理。比如 ARM 有用户态和内核态两种模式，它们的 TLB 是独立的：

```c
/* include/hw/core/cpu.h */
typedef struct CPUTLB {
    CPUTLBCommon c;
    CPUTLBDesc d[NB_MMU_MODES];
    CPUTLBDescFast f[NB_MMU_MODES];
} CPUTLB;
```

其中 `CPUTLBDescFast` 只包含快速路径需要的两个字段：

```c
/* include/exec/tlb-common.h */
typedef struct CPUTLBDescFast {
    uintptr_t mask;
    CPUTLBEntry *table;
} CPUTLBDescFast;
```

`mask` 的值是 `(n_entries - 1) << CPU_TLB_ENTRY_BITS`，用于从虚拟地址直接算出 TLB 索引。`table` 指向 `CPUTLBEntry` 数组。

除了主 TLB，每个 MMU 模式还有一个固定大小的 **victim TLB**（`CPUTLBDesc.vtable`）。当主 TLB 的一个 slot 被新条目替换时，旧条目会被"淘汰"到 victim TLB 里。如果后续访问刚好命中 victim TLB 中的条目，它会和主 TLB 中的条目交换回来。这个机制类似硬件 TLB 中的 victim cache，能有效减少冲突 miss。

---

## TCG 与 SoftMMU 的对接

理解了 TLB 的数据结构之后，我们来看 TCG 生成的代码是如何与 SoftMMU 交互的。这个过程分为前端和后端两个阶段。

### 前端：生成 TCG 内存操作

当 TCG 前端翻译一条客户机的 load/store 指令时，它调用 `tcg_gen_qemu_ld` 或 `tcg_gen_qemu_st` 系列函数（`tcg/tcg-op-ldst.c`），生成 `INDEX_op_qemu_ld` 或 `INDEX_op_qemu_st` 这样的 TCG 中间表示。这些 TCG op 携带了访问的大小、符号扩展、字节序等信息，编码在 `MemOp` 参数中。

以 RISC-V 的一条 load 指令为例，前端代码大致是：

```c
tcg_gen_qemu_ld_tl(dest, addr, ctx->mem_idx, MO_TESQ);
```

这里 `ctx->mem_idx` 是 MMU 索引（区分用户态/内核态等），`MO_TESQ` 表示目标字节序（Target Endian）、有符号（Signed）、64 位（Quad）。

---

### 后端：内联 TLB 检查

TCG 后端（比如 x86_64 后端）在把 `INDEX_op_qemu_ld` 编译成宿主机机器码时，会生成一段**内联的 TLB 检查代码**。这段代码直接嵌入在生成的翻译块（Translation Block）中，不经过函数调用。以 x86_64 后端的 `prepare_host_addr()` 为例（`tcg/x86_64/tcg-target.c.inc`），它生成的逻辑等价于：

```
index = (addr >> TARGET_PAGE_BITS) & fast->mask;
entry = &fast->table[index];
if (entry->addr_read == (addr & TARGET_PAGE_MASK)) {
    /* TLB 命中：host_addr = addr + entry->addend */
    goto fast_path;
} else {
    /* TLB 未命中：调用慢速路径 helper */
    goto slow_path;
}
```

这就是为什么 TLB 命中时开销很低——只有几条比较和跳转指令，没有任何函数调用。

---

## 访存的完整流程

把前面的内容串起来，一次客户机 load 操作的完整执行路径如下：

```
客户机 load 指令
      │
      v
TCG 前端翻译为 INDEX_op_qemu_ld
      │
      v
TCG 后端生成内联 TLB 检查
      │
      ├── [命中] addr + addend → 直接访问宿主机内存
      │
      └── [未命中] 调用 helper_ld*_mmu()
                │
                v
          mmu_lookup1()
                │
                ├── tlb_hit() 重新检查主 TLB
                │       (可能此时已被填充)
                │
                ├── victim_tlb_hit() 查找 victim TLB
                │       (命中则与主 TLB 交换)
                │
                └── tlb_fill_align()
                        │
                        v
                  arch 的 tlb_fill 回调
                  (遍历客户机页表)
                        │
                        v
                  tlb_set_page_full()
                  (填充 TLB 条目)
                        │
                        v
                  检查 TLB flags
                        │
                        ├── [RAM] 直接 memcpy
                        └── [MMIO] memory_region_dispatch_read()
```

下面我们沿着这条路径，看几个关键环节的实现。

---

### 慢速路径入口

当内联 TLB 检查未命中时，TCG 生成的代码会跳转到慢速路径，调用对应大小的 helper 函数。以 8 字节 load 为例（`accel/tcg/ldst_common.c.inc`）：

```c
/* accel/tcg/ldst_common.c.inc */
tcg_target_ulong helper_ldq_mmu(CPUArchState *env, uint64_t addr,
                                MemOpIdx oi, uintptr_t retaddr)
{
    return do_ld8_mmu(env_cpu(env), addr, oi, retaddr, MMU_DATA_LOAD);
}
```

---

### TLB 查找核心：mmu_lookup1

`do_ld8_mmu` 内部会调用 `mmu_lookup`，最终走到 `mmu_lookup1`——这是 SoftMMU 的核心查找函数（`accel/tcg/cputlb.c`）：

```c
/* accel/tcg/cputlb.c */
static bool mmu_lookup1(CPUState *cpu, MMULookupPageData *data,
                        MemOp memop, int mmu_idx,
                        MMUAccessType access_type, uintptr_t ra)
{
    vaddr addr = data->addr;
    uintptr_t index = tlb_index(cpu, mmu_idx, addr);
    CPUTLBEntry *entry = tlb_entry(cpu, mmu_idx, addr);
    uint64_t tlb_addr = tlb_read_idx(entry, access_type);
    bool maybe_resized = false;

    if (!tlb_hit(tlb_addr, addr)) {
        if (!victim_tlb_hit(cpu, mmu_idx, index, access_type,
                            addr & TARGET_PAGE_MASK)) {
            tlb_fill_align(cpu, addr, access_type, mmu_idx,
                           memop, data->size, false, ra);
            maybe_resized = true;
            index = tlb_index(cpu, mmu_idx, addr);
            entry = tlb_entry(cpu, mmu_idx, addr);
        }
        tlb_addr = tlb_read_idx(entry, access_type) & ~TLB_INVALID_MASK;
    }

    CPUTLBEntryFull *full = &cpu->neg.tlb.d[mmu_idx].fulltlb[index];
    data->full = full;
    data->flags = tlb_addr & TLB_FLAGS_MASK;
    data->haddr = (void *)((uintptr_t)addr + entry->addend);
    return maybe_resized;
}
```

这段代码的逻辑很清晰：先用 `tlb_hit()` 检查主 TLB，不中就查 victim TLB，还不中就调用 `tlb_fill_align()` 去遍历客户机页表。三步之后 TLB 一定被填充好了，函数通过 `data->haddr` 返回计算好的宿主机地址。

---

### tlb_fill：架构相关的页表遍历

`tlb_fill_align()` 最终会调用到目标架构注册的 `tlb_fill` 回调（`include/accel/tcg/cpu-ops.h`）：

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

每个目标架构（RISC-V、ARM、x86 等）都实现自己的 `tlb_fill`。它负责遍历客户机的页表，找到 GVA 对应的 GPA 和访问权限，然后调用 `tlb_set_page_full()` 把翻译结果填入 SoftTLB。如果页表遍历发现这次访问无效（比如缺页），`tlb_fill` 会向客户机注入异常——这和真实硬件的行为一致。

---

### tlb_set_page_full：填充 TLB 条目

`tlb_set_page_full()` 是 TLB 填充的最终落点（`accel/tcg/cputlb.c`），它的工作包括：

1. 通过 `address_space_translate_for_iotlb()` 把 GPA 翻译到具体的 `MemoryRegionSection`，确定这段地址是 RAM 还是 MMIO。
2. 如果是 RAM，计算 `addend`（即 HVA 与 GVA 之间的偏移量），后续快速路径直接用这个偏移量算出 HVA。
3. 如果是 MMIO，在 TLB 条目的地址字段中设置 `TLB_MMIO` 标志，强制后续访问走慢速路径。
4. 如果这个 RAM 页面需要脏页追踪（dirty page tracking），设置 `TLB_NOTDIRTY` 标志。
5. 把旧的 TLB 条目淘汰到 victim TLB，然后写入新条目。

这里有一个关键的设计思想：**TLB 条目中的标志位编码了后续访问需要走的路径**。普通 RAM 页面的 TLB 命中完全在内联代码中完成；而 MMIO、需要脏页追踪的页面、设了断点的页面等等，虽然也"命中"了 TLB，但标志位会迫使它们走到慢速路径中做额外处理。这套机制让 QEMU 能够在不影响快速路径性能的前提下，处理各种特殊情况。

---

## FlatView 与地址分派

前面提到 `tlb_set_page_full()` 需要把 GPA 翻译到 `MemoryRegionSection`。这个翻译依赖 QEMU 的内存管理框架——`AddressSpace`、`MemoryRegion` 和 `FlatView`。

`AddressSpace` 代表一个客户机可见的地址空间（通常有两个：`address_space_memory` 和 `address_space_io`），它的内部维护着一棵 `MemoryRegion` 树。但树形结构不适合做快速查找，所以 QEMU 会把这棵树"拍平"成一个 `FlatView`——一个按地址排序的 `FlatRange` 数组，每个 `FlatRange` 对应一段连续的地址映射。

---

当需要翻译一个 GPA 时，`flatview_do_translate()` 通过多级页表（`AddressSpaceDispatch`）在 FlatView 中定位到对应的 `MemoryRegionSection`（`system/physmem.c`）：

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
    if (page_mask_out) {
        *page_mask_out = ~TARGET_PAGE_MASK;
    }
    return *section;
}
```

---

找到 `MemoryRegionSection` 之后，实际的内存访问就分成两条路径。以读操作为例，`flatview_read_continue_step()`（`system/physmem.c`）展示了这个分支：

```c
/* system/physmem.c */
if (!memory_access_is_direct(mr, false, attrs)) {
    /* MMIO：调用设备模型的读回调 */
    uint64_t val;
    bool release_lock = prepare_mmio_access(mr);

    *l = memory_access_size(mr, *l, mr_addr);
    result = memory_region_dispatch_read(mr, mr_addr, &val,
                                         size_memop(*l), attrs);
    stn_he_p(buf, *l, val);

    if (release_lock) {
        bql_unlock();
    }
} else {
    /* RAM：直接从宿主机内存拷贝 */
    uint8_t *ram_ptr = qemu_ram_ptr_length(mr->ram_block, mr_addr,
                                           l, false, false);
    memcpy(buf, ram_ptr, *l);
}
```

对 RAM 的访问归结为一次 `memcpy`，因为客户机的物理内存就是 QEMU 进程地址空间中的一块 `mmap` 区域。对 MMIO 的访问则通过 `memory_region_dispatch_read()` 分派到设备模型注册的 `MemoryRegionOps.read` 回调——比如访问 UART 的数据寄存器，最终会调用到 UART 设备模型的 `uart_read()` 函数。MMIO 访问还需要持有 BQL（Big QEMU Lock），因为设备模型的代码通常不是线程安全的。

---

## IOMMU 与 DMA

在真实硬件上，DMA 引擎可以绕过 CPU 直接访问内存。如果系统配置了 IOMMU，DMA 使用的地址（IOVA）需要经过 IOMMU 翻译才能得到实际的物理地址。QEMU 在 SoftMMU 框架内完整地模拟了这个过程。

当 `flatview_do_translate()` 在翻译过程中发现目标 `MemoryRegion` 是一个 `IOMMUMemoryRegion`，它会调用 `address_space_translate_iommu()` 进行二次翻译（`system/physmem.c`）：

```c
/* system/physmem.c */
static MemoryRegionSection address_space_translate_iommu(
    IOMMUMemoryRegion *iommu_mr, hwaddr *xlat,
    hwaddr *plen_out, hwaddr *page_mask_out,
    bool is_write, bool is_mmio,
    AddressSpace **target_as, MemTxAttrs attrs)
{
    MemoryRegionSection *section;
    hwaddr page_mask = (hwaddr)-1;

    do {
        IOMMUMemoryRegionClass *imrc =
            memory_region_get_iommu_class_nocheck(iommu_mr);
        IOMMUTLBEntry iotlb;

        iotlb = imrc->translate(iommu_mr, *xlat,
                                is_write ? IOMMU_WO : IOMMU_RO, 0);

        if (!(iotlb.perm & (1 << is_write))) {
            goto unassigned;
        }

        *xlat = ((iotlb.translated_addr & ~iotlb.addr_mask)
                 | (*xlat & iotlb.addr_mask));
        page_mask &= iotlb.addr_mask;
        *target_as = iotlb.target_as;

        section = address_space_translate_internal(
                address_space_to_dispatch(iotlb.target_as),
                *xlat, xlat, plen_out, is_mmio);

        iommu_mr = memory_region_get_iommu(section->mr);
    } while (unlikely(iommu_mr));

    /* ... */
    return *section;
}
```

这个函数有一个 `do...while` 循环——如果翻译后的地址落在另一个 IOMMU 区域里（嵌套 IOMMU 的场景），它会继续翻译，直到最终落到一个普通的 `MemoryRegion` 上。循环中还会检查 IOMMU 页表的权限位，如果 DMA 操作没有对应的读写权限，访问会被拒绝并路由到 `io_mem_unassigned`。

对于设备模型中发起的 DMA 访问，QEMU 提供了 `address_space_map()` 接口。如果 DMA 目标是 RAM，这个函数直接返回宿主机指针，设备可以直接读写；如果目标是 MMIO 或者经过 IOMMU 翻译后的间接区域，QEMU 会分配一个 bounce buffer 来中转数据。

---

## TLB 刷新

客户机 OS 在修改页表、切换进程、或者更新 IOMMU 映射时，需要刷新 TLB 以保证地址翻译的一致性。QEMU 提供了一组 TLB 刷新函数（`include/exec/cputlb.h`）：

```c
/* include/exec/cputlb.h */

/* 刷新单个 CPU 的整个 TLB */
void tlb_flush(CPUState *cpu);

/* 刷新单个页面 */
void tlb_flush_page(CPUState *cpu, vaddr addr);

/* 按 MMU 模式刷新 */
void tlb_flush_by_mmuidx(CPUState *cpu, MMUIdxMap idxmap);

/* 跨 CPU 同步刷新（用于多核场景） */
void tlb_flush_all_cpus_synced(CPUState *src_cpu);
void tlb_flush_page_all_cpus_synced(CPUState *src, vaddr addr);
```

在多核模拟（MTTCG）下，每个 vCPU 运行在独立的宿主机线程中，各自维护独立的 TLB。当一个 vCPU 需要刷新其他 vCPU 的 TLB 时（比如执行了 TLB 广播指令），就需要用 `_all_cpus_synced` 系列函数。这些函数通过 QEMU 的"安全工作"（safe work）机制，将刷新操作投递到目标 vCPU 的线程中同步执行。

此外，SoftTLB 的大小是动态调整的。QEMU 会根据一段时间窗口内的 TLB 使用率来决定是否扩大或缩小主 TLB 的容量，在内存占用和命中率之间取得平衡。

---

## TLB 标志位与脏页追踪

前面提到 `CPUTLBEntry` 的地址字段中编码了标志位。这些标志位定义在 `include/exec/tlb-flags.h` 中：

| 标志位 | 含义 |
|--------|------|
| `TLB_INVALID_MASK` | 条目无效 |
| `TLB_MMIO` | 访问目标是 MMIO，必须走慢速路径 |
| `TLB_NOTDIRTY` | 页面需要脏页追踪，写入时需要标记为 dirty |
| `TLB_WATCHPOINT` | 页面上设置了调试断点 |
| `TLB_FORCE_SLOW` | 强制走慢速路径（用于插件等） |
| `TLB_BSWAP` | 需要字节序转换 |

其中 `TLB_NOTDIRTY` 与实时迁移（live migration）密切相关。在迁移过程中，QEMU 需要追踪哪些内存页被修改过。通过在 TLB 条目中设置 `TLB_NOTDIRTY`，每次写入这样的页面都会走慢速路径，慢速路径中会把该页标记为 dirty，然后清除 `TLB_NOTDIRTY` 标志让后续写入回到快速路径。这样就实现了按需追踪，不影响未被追踪页面的性能。

---

## 小结

SoftMMU 是 QEMU 系统模式的地址转换与设备访问中枢。它通过 SoftTLB 缓存翻译结果，通过 FlatView 分派物理地址到 RAM 或 MMIO，通过 IOMMU 翻译支持 DMA 地址隔离。理解 SoftMMU 的运作——从 TCG 生成内联 TLB 检查，到慢速路径的页表遍历和 TLB 填充，再到 FlatView 的地址查找和设备回调分派——是深入阅读 QEMU 内存子系统代码的基础。

!!! tip "进一步阅读"

    - [QEMU Glossary](https://www.qemu.org/docs/master/glossary.html)：SoftMMU 与 system mode 的官方定义
    - [QEMU Memory API](https://www.qemu.org/docs/master/devel/memory.html)：AddressSpace / MemoryRegion / FlatView 的开发者文档
    - `accel/tcg/cputlb.c`：SoftTLB 的核心实现
    - `system/physmem.c`：FlatView 翻译与物理内存访问
    - `include/exec/tlb-common.h`：TLB 数据结构定义

!!! question "随堂测验"

    [>> 【点击进入随堂测验】2-3 分钟小测，快速巩固 ☄](https://ima.qq.com/quiz?quizId=QWFARxqeKBU1aF3kcFfrT5nHGfWBd3n8dWV0S6Af2fAD)
