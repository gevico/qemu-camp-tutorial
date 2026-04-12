
# Memory Region 面向地址空间抽象

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

!!! info "QEMU 版本"

    本文基于 QEMU **v10.2.0**（tag: [`v10.2.0`](https://gitlab.com/qemu-project/qemu/-/tags/v10.2.0)，commit: `75eb8d57c6b9`）。

!!! tip "概览"

    - 地址空间与 MemoryRegion 的抽象与分工
    - 访存流程与设备映射的基本规则
    - 通过 `info mtree` 观察地址空间布局
    - MemoryRegion 初始化流程与关键结构
    - 地址空间节点的层级关系

## 基本介绍

从 CPU 的角度来说，一切访存行为都是对地址进行操作的（load/store），CPU 并不关心这个地址背后对应的是什么设备，只要能读写到正确结果即可。

比如执行一条访存指令：

!!! note "CPU 访存流程"

    1. CPU 在计算（通过算术逻辑单元 ALU）出目标地址以后，将其发送到地址总线上，同时 CPU 还会给出读写的控制信号；

    2. 地址对应的设备，可能是一块普通内存，也可能是一个 I/O 设备（这里特指外设），会对地址总线的信号进行响应；

    3. 如果是读操作，则将该地址对应的数据，按照 CPU 指定的位宽大小，通过总线传输回去，一般是存放到 CPU 访存指令给出的寄存器内；

    4. 如果是写操作，则会把总线传递过来的数据，按照 CPU 指定的位宽大小，写入指定地址里面，如果是 I/O 设备，一般是更新了这个地址对应的寄存器，并可能产生副作用。

为了实现以上流程，QEMU 提供了一套内存模拟的机制，当然实际上会更复杂，我们挑几个比较重要的概念，尽量以通俗易懂的方式讲出来。

为了能够模拟内存/外设的行为，QEMU 至少要实现以下机制：

!!! tip

    1. 基本的地址空间管理，能够根据 CPU 投递过来的地址，区分是什么设备；

    2. 实现地址的离散映射，有些外设的地址不一定是连续的；

    3. 实现地址的重映射，比如 MCS-51 的 RAM、XRAM 都是从 0 地址开始的；

为此，QEMU 提供了两个概念，address-space 和 memory-region（下文简称为 mr），前者用于描述整个地址空间的映射关系（不同部件看到的地址空间可能不同），后者用于描述地址空间中某个地址范围内的映射规则。

## 地址空间布局

理解了这些概念之后，我们用一个具体的例子来看看 QEMU 是如何组织 virt 主板的地址空间的。通过 QEMU 的 monitor 控制台，可以直接查看当前的地址映射关系。

我们通过 QEMU 的如下命令进入控制台，打印以下 RISC-V 的 virt machine 作为参考：

```bash
qemu-system-riscv64 -M virt -monitor stdio -s -S -display none
QEMU 10.0.50 monitor - type 'help' for more information
(qemu)
```

然后我们输入 `info mtree` 命令可以看到地址空间的布局：

```bash
(qemu) info mtree
address-space: I/O
  0000000000000000-000000000000ffff (prio 0, i/o): io

address-space: cpu-memory-0
address-space: memory
  0000000000000000-ffffffffffffffff (prio 0, i/o): system
    0000000000001000-000000000000ffff (prio 0, rom): riscv_virt_board.mrom
    0000000000100000-0000000000100fff (prio 0, i/o): riscv.sifive.test
    0000000000101000-0000000000101023 (prio 0, i/o): goldfish_rtc
    0000000002000000-0000000002003fff (prio 0, i/o): riscv.aclint.swi
    0000000002004000-000000000200bfff (prio 0, i/o): riscv.aclint.mtimer
    0000000003000000-000000000300ffff (prio 0, i/o): gpex_ioport_window
      0000000003000000-000000000300ffff (prio 0, i/o): gpex_ioport
    0000000004000000-0000000005ffffff (prio 0, i/o): platform bus
    000000000c000000-000000000c5fffff (prio 0, i/o): riscv.sifive.plic
    0000000010000000-0000000010000007 (prio 0, i/o): serial
    0000000010001000-00000000100011ff (prio 0, i/o): virtio-mmio
    ...
    0000000010008000-00000000100081ff (prio 0, i/o): virtio-mmio
    0000000010100000-0000000010100007 (prio 0, i/o): fwcfg.data
    0000000010100008-0000000010100009 (prio 0, i/o): fwcfg.ctl
    0000000010100010-0000000010100017 (prio 0, i/o): fwcfg.dma
    0000000020000000-0000000021ffffff (prio 0, romd): virt.flash0
    0000000022000000-0000000023ffffff (prio 0, romd): virt.flash1
    0000000030000000-000000003fffffff (prio 0, i/o): alias pcie-ecam @pcie-mmcfg-mmio 0000000000000000-000000000fffffff
    0000000040000000-000000007fffffff (prio 0, i/o): alias pcie-mmio @gpex_mmio_window 0000000040000000-000000007fffffff
    0000000080000000-0000000087ffffff (prio 0, ram): riscv_virt_board.ram
    0000000400000000-00000007ffffffff (prio 0, i/o): alias pcie-mmio-high @gpex_mmio_window 0000000400000000-00000007ffffffff

address-space: gpex-root
  0000000000000000-ffffffffffffffff (prio 0, i/o): bus master container

memory-region: pcie-mmcfg-mmio
  0000000000000000-000000000fffffff (prio 0, i/o): pcie-mmcfg-mmio

memory-region: gpex_mmio_window
  0000000000000000-ffffffffffffffff (prio 0, i/o): gpex_mmio_window
    0000000000000000-ffffffffffffffff (prio 0, i/o): gpex_mmio

memory-region: system
  0000000000000000-ffffffffffffffff (prio 0, i/o): system
    0000000000001000-000000000000ffff (prio 0, rom): riscv_virt_board.mrom
    0000000000100000-0000000000100fff (prio 0, i/o): riscv.sifive.test
    0000000000101000-0000000000101023 (prio 0, i/o): goldfish_rtc
    0000000002000000-0000000002003fff (prio 0, i/o): riscv.aclint.swi
    0000000002004000-000000000200bfff (prio 0, i/o): riscv.aclint.mtimer
    0000000003000000-000000000300ffff (prio 0, i/o): gpex_ioport_window
      0000000003000000-000000000300ffff (prio 0, i/o): gpex_ioport
    0000000004000000-0000000005ffffff (prio 0, i/o): platform bus
    000000000c000000-000000000c5fffff (prio 0, i/o): riscv.sifive.plic
    0000000010000000-0000000010000007 (prio 0, i/o): serial
    0000000010001000-00000000100011ff (prio 0, i/o): virtio-mmio
    ...
    0000000010008000-00000000100081ff (prio 0, i/o): virtio-mmio
    0000000010100000-0000000010100007 (prio 0, i/o): fwcfg.data
    0000000010100008-0000000010100009 (prio 0, i/o): fwcfg.ctl
    0000000010100010-0000000010100017 (prio 0, i/o): fwcfg.dma
    0000000020000000-0000000021ffffff (prio 0, romd): virt.flash0
    0000000022000000-0000000023ffffff (prio 0, romd): virt.flash1
    0000000030000000-000000003fffffff (prio 0, i/o): alias pcie-ecam @pcie-mmcfg-mmio 0000000000000000-000000000fffffff
    0000000040000000-000000007fffffff (prio 0, i/o): alias pcie-mmio @gpex_mmio_window 0000000040000000-000000007fffffff
    0000000080000000-0000000087ffffff (prio 0, ram): riscv_virt_board.ram
    0000000400000000-00000007ffffffff (prio 0, i/o): alias pcie-mmio-high @gpex_mmio_window 0000000400000000-00000007ffffffff
```

结合这个输出，我们来讲讲 QEMU 是如何实现内存虚拟化（准确说是模拟）的。

一个 Guest（表示被模拟的对象，这里指 virt machine）可以有多个 address-space，每个 address-space 描述的地址映射关系不一定相同，典型的是 I/O 和 memory。

每个 address-space 对应一个 mr 树，比如 address-space: memory 对应的 mr 的根节点是 system，子节点按照地址大小顺序排列。

由于 mr 描述的是某个具体地址范围内的映射规则，因此可以很方便地实现设备的离散映射。

mr 支持同一级之间地址范围重叠，重叠的部分按照优先级呈现，高优先级的重叠部分作为访问目标。(prio 0, type) 中的 prio 后跟着的是优先级，virt 的外设之间没有地址重叠，因此优先级都是 0。

这里举例说明：

```bash
0x8000   0x70000  0x60000  0x50000  0x40000  0x30000  0x20000  0x10000    0
  |--------|--------|--------|--------|--------|--------|--------|--------|
A:[-----------------------------------------------------------------------] prio:0
B:[-----------------------------------------------------] prio:1
C:[-----------------------------------] prio:2
D:[-----------------] prio:3
```

对于 mr A 来说，它的地址范围可以看成：

```bash
0x8000   0x70000  0x60000  0x50000  0x40000  0x30000  0x20000  0x10000    0
  |--------|--------|--------|--------|--------|--------|--------|--------|
A:[DDDDDDDDDDDDDDDDD|CCCCCCCCCCCCCCCCC|BBBBBBBBBBBBBBBBB|AAAAAAAAAAAAAAAAA]
```

为了实现以上机制，QEMU 使用 alias 来描述 mr 中重叠的部分，使用 alias 可以将一个 mr 的一部分放到另外一个 mr 上，以此来简化内存模拟的复杂度（可以类比 mmap）。

## 初始化流程

我们从 QEMU 初始化过程，来理解 mr 和 address-space 的关系：

```bash
main() // system/main.c
|--qemu_init(argc, argv) // system/vlc.c
|  |--cpu_exec_init_all() // system/physmem.c
|  |  |--io_mem_init()
|  |  |  |--memory_region_init_io(&io_mem_unassigned, NULL, &unassigned_mem_ops, NULL, NULL, UINT64_MAX)
|  |  |--memory_map_init()
|  |  |  |--memory_region_init(system_memory, NULL, "system", UINT64_MAX)
|  |  |  |--address_space_init(&address_space_memory, system_memory, "memory")
|  |  |  |--memory_region_init_io(system_io, NULL, &unassigned_io_ops, NULL, "io", 65536)
|  |  |  |--address_space_init(&address_space_io, system_io, "I/O")
```

这里我们重点关注 memory_region_init() 和 address_space_init()。

对于 memory_region_init() ，最终调用到 memory_region_do_init() ：

```bash

static void memory_region_do_init(MemoryRegion *mr,
                                  Object *owner,
                                  const char *name,
                                  uint64_t size)
{
    mr->size = int128_make64(size);
    if (size == UINT64_MAX) {
        mr->size = int128_2_64();
    }
    mr->name = g_strdup(name);
    mr->owner = owner;
    mr->dev = (DeviceState *) object_dynamic_cast(mr->owner, TYPE_DEVICE);
    mr->ram_block = NULL;

    if (name) {
        char *escaped_name = memory_region_escape_name(name);
        char *name_array = g_strdup_printf("%s[*]", escaped_name);

        if (!owner) {
            owner = machine_get_container("unattached");
        }

        object_property_add_child(owner, name_array, OBJECT(mr));
        object_unref(OBJECT(mr));
        g_free(name_array);
        g_free(escaped_name);
    }
}
```

在这段代码会完成 mr 一些关键字段的初始化，比如：

```bash
/** MemoryRegion:
 *
 * A struct representing a memory region.
 */
struct MemoryRegion {
    Object parent_obj;

    /* private: */
    Object *owner;
    const MemoryRegionOps *ops;
    Int128 size;
    QTAILQ_HEAD(, MemoryRegion) subregions;
    QTAILQ_ENTRY(MemoryRegion) subregions_link;
    ...
};
```

ops 指向 mr 访存的实际接口；而 subregions 指向其他 mr，通过 subregions，可以将所有关联的 mr 串起来。

这部分初始化代码，有一些是注册的函数回调，静态 review 代码不太方便理清中间的逻辑，可以借助 gdb 来操作。

system_memory 是一个全局变量指针，指向 mr 的根节点，我们可以对 system_memory->ops 和 system_memory->subregions 进行监视，看看是在哪个函数内被初始化的。

首先观察 system_memory->ops，命令和流程如下（为了方便阅读，对 GDB 打印信息做了简化处理）：

```bash
$gdb ./build/qemu-system-riscv64
(gdb) b memory_map_init
Breakpoint 1 at 0x6a1626: file ../system/physmem.c, line 2557.
(gdb) run
(gdb) watch system_memory->ops
(gdb) c
Old value = <unreadable>
New value = (const MemoryRegionOps *) 0xde4df4fda8189d90
memory_map_init () at ../system/physmem.c:2559
(gdb) c
Old value = (const MemoryRegionOps *) 0xde4df4fda8189d90
New value = (const MemoryRegionOps *) 0x00x00007ffff6a58ee3 in ?? () from /usr/lib/libc.so.6
(gdb) c
Old value = (const MemoryRegionOps *) 0x0
New value = (const MemoryRegionOps *) 0x5555562e76a0 <unassigned_mem_ops>
memory_region_initfn (obj=<optimized out>) at ../system/memory.c:1277
(gdb)
```

第一次和第二次命中监视点，是对 ops 进行 reset 操作，第三次命中，是真正初始化的地方，我们可以观察一下调用栈：

```bash
(gdb) bt
#0  memory_region_initfn (obj=) at ../system/memory.c:1277
#1  object_init_with_type (obj=, ti=) at ../qom/object.c:429
#2  object_initialize_with_type (obj=obj@entry=, size=size@entry=272, type=) at ../qom/object.c:571
#3  object_initialize (data=data@entry=, size=size@entry=272, typename=typename@entry= "memory-region") at ../qom/object.c:595
#4  memory_region_init (mr=, owner=0x0, name= "system", size=) at ../system/memory.c:1224
#5  memory_map_init () at ../system/physmem.c:2559
#6  cpu_exec_init_all () at ../system/physmem.c:3071
#7  qemu_create_machine (qdict=) at ../system/vl.c:2120
#8  qemu_init (argc=<optimized out>, argv=) at ../system/vl.c:3664
#9  main (argc=<optimized out>, argv=<optimized out>) at ../system/main.c:47
(gdb)
```

可以看到 memory_region_initfn() 是在 object_init_with_type() 中被调用，这是 QEMU 的 QOM 模块，可以简单理解为是对 mr 对象的初始化，这个初始化方法是注册的一个函数指针。

这块儿暂时不去深究，主要是给大家演示通过 GDB 来理解代码意图的方法。

以此类推，我们可以得到 system_memory->subregions 是在哪里被初始化的，你可以自己尝试，如何获得下面的输出：

```bash
Thread 1 "qemu-system-ris" hit Hardware watchpoint 3: system_memory->subregions
Old value = {
  tqh_first = 0x0,
  tqh_circ = {
    tql_next = 0x0,
    tql_prev = 0x0
  }
}

New value = {
  tqh_first = 0x0,
  tqh_circ = {
    tql_next = 0x0,
    tql_prev = 0x5555564de378
  }
}
...

in memory_region_initfn (obj=<optimized out>) at ../system/memory.c:1281QTAILQ_INIT(&mr->coalesced);
```

接着我们将它的函数调用栈打印出来：

```bash
(gdb) bt
#0  memory_region_initfn (obj=<optimized out>) at ../system/memory.c:1281
#1  object_init_with_type (obj=..., ti=...) at ../qom/object.c:429
#2  object_initialize_with_type (obj=obj@entry=..., size=size@entry=272, type=...) at ../qom/object.c:571
#3  object_initialize (data=data@entry=0x5555564de2c0, size=size@entry=272, typename=typename@entry=... "memory-region") at ../qom/object.c:595
#4  memory_region_init (mr=..., owner=0x0, name=... "system", size=...) at ../system/memory.c:1224
#5  memory_map_init () at ../system/physmem.c:2559
#6  cpu_exec_init_all () at ../system/physmem.c:3071
#7  qemu_create_machine (qdict=...) at ../system/vl.c:2120
#8  qemu_init (argc=<optimized out>, argv=...) at ../system/vl.c:3664
#9  main (argc=<optimized out>, argv=<optimized out>) at ../system/main.c:47
```

可以看到，system_memory->subregions 同样是在 memory_region_initfn() 内部被完成初始化的。

## 节点间关系

如果进一步监视 system_memory->subregions，你将得到这个其他 mr 节点是被如何添加进来的：

```bash
(gdb) c
Thread 1 "qemu-system-ris" hit Hardware watchpoint 3: system_memory->subregions
Old value ={
  tqh_first = 0x0,
  tqh_circ = {
    tql_next = 0x0,
    tql_prev = 0x5555564de378
  }
}
New value = {
  tqh_first = 0x5555567e16f0,
  tqh_circ = {
    tql_next = 0x5555567e16f0,
    tql_prev = 0x5555564de378
  }
}
memory_region_update_container_subregions (subregion=0x5555567e16f0) at ../system/memory.c:26452645
memory_region_update_pending |= mr->enabled && subregion->enabled;
...

(gdb) bt
#0  memory_region_update_container_subregions (subregion=) at ../system/memory.c:2645
#1  memory_region_add_subregion_common (mr=<optimized out>, offset=<optimized out>, subregion=) at ../system/memory.c:2661
#2  riscv_aclint_swi_create (addr=addr@entry=, hartid_base=hartid_base@entry=0,num_harts=num_harts@entry=1, sswi=sswi@entry=false) at ../hw/intc/riscv_aclint.c:546
#3  spike_board_init (machine=) at ../hw/riscv/spike.c:248
#4  machine_run_board_init (machine=, mem_path=<optimized out>, errp=<optimized out>, errp@entry= <error_fatal>) at ../hw/core/machine.c:1548
#5  qemu_init_board () at ../system/vl.c:2613
#6  qmp_x_exit_preconfig (errp= <error_fatal>) at ../system/vl.c:2705
#7  qemu_init (argc=<optimized out>, argv=<optimized out>) at ../system/vl.c:3739
#8  main (argc=<optimized out>, argv=<optimized out>) at ../system/main.c:47
```

memory_region_update_container_subregions() 的过程很简单，最终执行的结果如下：

```bash
                          struct MemoryRegion
                        +------------------------+
                        |subregions              |
                        |    QTAILQ_HEAD()       |
                        +------------------------+
                                    |
                +-------------------+---------------------+
                |                                         |
                |                                         |
        struct MemoryRegion                      struct MemoryRegion
    +------------------------+                +------------------------+
    |subregions              |                |subregions              |
    |    QTAILQ_HEAD()       |                |    QTAILQ_HEAD()       |
    +------------------------+                +------------------------+
          ...                                            ...
```

是不是很像一个树形结构？其实这就是红黑树。

address-space 内有一个 root 字段，指向 memory-region 的根节点，这样就实现了一个 address-space 对应一个 memory-region 树，如下：

```bash
                        AddressSpace
                   +-------------------------+
                   |name                     |
                   |   (char *)              |
                   |                         |     MemoryRegion(system_memory/system_io)
                   +-------------------------+          +------------------------+
                   |root                     |          |subregions              |
                   |   (MemoryRegion *)      | -------->|    QTAILQ_HEAD()       |
                   +-------------------------+          +------------------------+
                                                                     |
                                                                     |
                                                 +-------------------+---------------------+
                                                 |                                         |
                                      struct MemoryRegion                          struct MemoryRegion
                                      +------------------------+                   +------------------------+
                                      |subregions              |                   |subregions              |
                                      |    QTAILQ_HEAD()       |                   |    QTAILQ_HEAD()       |
                                      +------------------------+                   +------------------------+
```

每个 mr 会对应到具体的内存块 RAMBlock，这个内存块从 Host 申请，作为 Guest 外围设备的存储。

mr 提供了一些类型，用于描述存储设备，常见的有 RAM、ROM、IOMMU、container。

我们回到 QEMU 的交互终端，使用如下命令，我们可以打印 virt 的 mr 分布和对应的外设：

```bash
(qemu) info qom-tree
(qemu) info qom-tree
/machine (virt-machine)
  /fw_cfg (fw_cfg_mem)
    /\x2from@etc\x2facpi\x2frsdp[0] (memory-region)
    /\x2from@etc\x2facpi\x2ftables[0] (memory-region)
    /\x2from@etc\x2ftable-loader[0] (memory-region)
    /fwcfg.ctl[0] (memory-region)
    /fwcfg.data[0] (memory-region)
    /fwcfg.dma[0] (memory-region)
  /peripheral (container)
  /peripheral-anon (container)
  /soc0 (riscv.hart_array)
    /harts[0] (rv64-riscv-cpu)
      /riscv.cpu.rnmi[0] (irq)
      /riscv.cpu.rnmi[10] (irq)
      ...
```

对于 mr container 类型，它包含了其他的 mr，记录每个 mr 的 offset。

在实际应用场景，我们可以利用 mr container 创建不同的地址层级关系，可以在地址空间层面，清晰的描述不同子系统的关系，对于实现模块化有很好的帮助。

!!! question "随堂测验"

    [>> 【点击进入随堂测验】2-3 分钟小测，快速巩固 ☄](https://ima.qq.com/quiz?quizId=amlCeFf3K4joOXecODwuHBCv2BpUBx095JMrXLIElAUB)
