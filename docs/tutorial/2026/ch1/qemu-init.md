# QEMU 启动流程分析

## 分析思路

对一个软件源码建立最直观印象的方法，就是观测它的初始化流程。QEMU 是一个 C 为主体的项目，所以理所当然我们要从 main 函数开始追踪。

以 qemu-system-riscv64 为例，我们使用如下命令启动：

```bash
qemu-system-riscv64 -M virt -s -S -nographic
```

这个命令让 QEMU 创建了一个 virt Machine，以 nographic 模式运行，串口输出到终端，默认 bios 使用 OpenSBI，并且开启了 gdbstub 远程调试功能，允许 riscv64-gdb 来调试客户机程序，默认端口号是 1234，同时停在第一条指令，等待 gdb 的连接。

!!! note
    我们先观察 virt Machine 是如何创建的，然后再探讨一下 QEMU 是如何加载 OpenSBI 的二进制程序到 virt Machine 的内存里面的，最后再看 QEMU 是如何初始化 vCPU 指向第一条 Guest 指令的。

把以上流程梳理清楚，我们就对 QEMU 的工作原理有更多的了解了，其他 Machine 的初始化和准备工作，基本类似。

所以本小节，讲述的是一个方法论，让你快速分析不同的 Machine，或者对于本训练营没有覆盖到知识点，你也有足够的手段去研究它。

## virt Machine 初始化

最方便的办法，是通过 gdb 来反向定位源码。QEMU 源码中充斥各种 C 宏魔法，对于刚接触 QEMU 的人来说，看起来会有一些吃力，使用 gdb 调试，可以更有针对性分析我们关注的部分，抽丝剥茧，层层拨开 QEMU 源码的神秘面纱。

按照前面 QOM 的讲解，virt Machine 必定属于一个 Qobject，我们可以在它的 class 初始化或者 object 实例化的源码位置，打一个断点，来观察调用栈。这里我们先搜索一下 virt Machine 源码里关于 typeinfo 相关的代码：

```c
static const TypeInfo virt_machine_typeinfo = {
    .name       = MACHINE_TYPE_NAME("virt"),
    .parent     = TYPE_MACHINE,
    .class_init = virt_machine_class_init,
    .instance_init = virt_machine_instance_init,
    .instance_size = sizeof(RISCVVirtState),
    .interfaces = (const InterfaceInfo[]) {
         { TYPE_HOTPLUG_HANDLER },
         { }
    },
};

static void virt_machine_init_register_types(void)
{
    type_register_static(&virt_machine_typeinfo);
}

type_init(virt_machine_init_register_types)
```

所以，我们可以给 `virt_machine_class_init()` 和 `virt_machine_instance_init()` 分别下两个断点。

使用下面的命令用 gdb 调试 QEMU :

```bash
gdb qemu-system-riscv64 -ex "set args -M virt -nographic"
(gdb) b virt_machine_class_init
(gdb) b virt_machine_instance_init
(gdb) r
...
```

首先我们跟踪到的，是 virt_machine_class_init 函数，看一下调用栈：

```bash
(gdb) bt
#0  virt_machine_class_init (oc=0x5555572012d0, data=0x0) at ../hw/riscv/virt.c:1916
#1  0x0000555555dc0d11 in type_initialize (ti=0x555556ffab50) at ../qom/object.c:1123
#2  object_class_foreach_tramp (key=<optimized out>, value=0x555556ffab50, opaque=0x7fffffffd8a0) at ../qom/object.c:1110
#3  0x00007ffff6f7380b in g_hash_table_foreach () from /usr/lib/libglib-2.0.so.0
#4  0x0000555555dc15f1 in object_class_foreach (fn=0x555555dbf370 <object_class_get_list_tramp>, implements_type=<optimized out>, include_abstract=false,
    opaque=0x7fffffffd898) at ../qom/object.c:87
#5  object_class_get_list (implements_type=implements_type@entry=0x555555fa02e2 "machine", include_abstract=include_abstract@entry=false)
    at ../qom/object.c:1189
#6  0x0000555555b22cc1 in select_machine (errp=0x7fffffffd930, qdict=0x555557009e70) at ../system/vl.c:1675
#7  qemu_create_machine (qdict=0x555557009e70) at ../system/vl.c:2187
#8  qemu_init (argc=<optimized out>, argv=0x7fffffffdb98) at ../system/vl.c:3759
#9  0x00005555558cbff9 in main (argc=<optimized out>, argv=<optimized out>) at ../system/main.c:71
```

我们再看看 virt_machine_instance_init 的调用栈：

```bash
(gdb) c
Continuing.

Thread 1 "qemu-system-ris" hit Breakpoint 2, virt_machine_instance_init (obj=0x55555720cca0) at /home/zevorn/qemu/include/hw/riscv/virt.h:35
35      DECLARE_INSTANCE_CHECKER(RISCVVirtState, RISCV_VIRT_MACHINE,
(gdb) bt
#0  virt_machine_instance_init (obj=0x55555720cca0) at /home/zevorn/qemu/include/hw/riscv/virt.h:35
#1  0x0000555555dc1c4c in object_init_with_type (obj=0x55555720cca0, ti=0x555556ffab50) at ../qom/object.c:428
#2  object_initialize_with_type (obj=0x55555720cca0, size=<optimized out>, type=0x555556ffab50) at ../qom/object.c:570
#3  0x0000555555dc1ed7 in object_new_with_type (type=0x555556ffab50) at ../qom/object.c:774
#4  0x0000555555dc1f48 in object_new_with_class (klass=klass@entry=0x5555572012d0) at ../qom/object.c:782
#5  0x0000555555b248a8 in qemu_create_machine (qdict=0x555557009e70) at ../system/vl.c:2190
#6  qemu_init (argc=<optimized out>, argv=0x7fffffffdb98) at ../system/vl.c:3759
#7  0x00005555558cbff9 in main (argc=<optimized out>, argv=<optimized out>) at ../system/main.c:71
(gdb)
```

这里可以看到，main 函数首先调用了 qemu_init 函数，然后再调用 qemu_create_machine 函数来创建 machine:

```bash
main() → qemu_init() → qemu_create_machine()
```

然后先创建 class，然后再实例化 qobject，这和前面讲解 QOM 给出的流程一致。

另外我们还比较关注这两个函数内部的实现，这时候可以进一步阅读代码：

```c
static void virt_machine_class_init(ObjectClass *oc, const void *data)
{
    MachineClass *mc = MACHINE_CLASS(oc);
    HotplugHandlerClass *hc = HOTPLUG_HANDLER_CLASS(oc);

    mc->desc = "RISC-V VirtIO board";
    mc->init = virt_machine_init;
    mc->max_cpus = VIRT_CPUS_MAX;
    mc->default_cpu_type = TYPE_RISCV_CPU_BASE;
    mc->block_default_type = IF_VIRTIO;
    mc->no_cdrom = 1;
    mc->pci_allow_0_address = true;
    mc->possible_cpu_arch_ids = riscv_numa_possible_cpu_arch_ids;
    mc->cpu_index_to_instance_props = riscv_numa_cpu_index_to_props;
    mc->get_default_cpu_node_id = riscv_numa_get_default_cpu_node_id;
    mc->numa_mem_supported = true;
    /* platform instead of architectural choice */
    mc->cpu_cluster_has_numa_boundary = true;
    mc->default_ram_id = "riscv_virt_board.ram";
    assert(!mc->get_hotplug_handler);
    mc->get_hotplug_handler = virt_machine_get_hotplug_handler;

    hc->plug = virt_machine_device_plug_cb;

    machine_class_allow_dynamic_sysbus_dev(mc, TYPE_RAMFB_DEVICE);
    machine_class_allow_dynamic_sysbus_dev(mc, TYPE_UEFI_VARS_SYSBUS);
#ifdef CONFIG_TPM
    machine_class_allow_dynamic_sysbus_dev(mc, TYPE_TPM_TIS_SYSBUS);
#endif

    /* class property intialization */
    object_class_property_add_bool(oc, "aclint", virt_get_aclint,
                                   virt_set_aclint);
    object_class_property_set_description(oc, "aclint",
                                          "(TCG only) Set on/off to "
                                          "enable/disable emulating "
                                          "ACLINT devices");
    ...
}

static void virt_machine_instance_init(Object *obj)
{
    RISCVVirtState *s = RISCV_VIRT_MACHINE(obj);

    virt_flash_create(s);

    s->oem_id = g_strndup(ACPI_BUILD_APPNAME6, 6);
    s->oem_table_id = g_strndup(ACPI_BUILD_APPNAME8, 8);
    s->acpi = ON_OFF_AUTO_AUTO;
    s->iommu_sys = ON_OFF_AUTO_AUTO;
}

```

可以看到，instance 里面的逻辑不多，我们重点看 class 初始化的函数，里面有一个函数的注册很值得关注，virt_machine_init，其他代码更像是配置了一些属性，我们把解析放在代码后面讲：

```c
static void virt_machine_init(MachineState *machine)
{
    RISCVVirtState *s = RISCV_VIRT_MACHINE(machine);
    MemoryRegion *system_memory = get_system_memory();
    MemoryRegion *mask_rom = g_new(MemoryRegion, 1);
    DeviceState *mmio_irqchip, *virtio_irqchip, *pcie_irqchip;
    int i, base_hartid, hart_count;
    int socket_count = riscv_socket_count(machine);

    s->memmap = virt_memmap;

    /* Check socket count limit */
    if (VIRT_SOCKETS_MAX < socket_count) {
        error_report("number of sockets/nodes should be less than %d",
            VIRT_SOCKETS_MAX);
        exit(1);
    }

    if (!virt_aclint_allowed() && s->have_aclint) {
        error_report("'aclint' is only available with TCG acceleration");
        exit(1);
    }

    /* Initialize sockets */
    mmio_irqchip = virtio_irqchip = pcie_irqchip = NULL;
    for (i = 0; i < socket_count; i++) {
        g_autofree char *soc_name = g_strdup_printf("soc%d", i);

        if (!riscv_socket_check_hartids(machine, i)) {
            error_report("discontinuous hartids in socket%d", i);
            exit(1);
        }

        base_hartid = riscv_socket_first_hartid(machine, i);
        if (base_hartid < 0) {
            error_report("can't find hartid base for socket%d", i);
            exit(1);
        }

        hart_count = riscv_socket_hart_count(machine, i);
        if (hart_count < 0) {
            error_report("can't find hart count for socket%d", i);
            exit(1);
        }

        /* cpu object property initialization */
        object_initialize_child(OBJECT(machine), soc_name, &s->soc[i],
                                TYPE_RISCV_HART_ARRAY);
        object_property_set_str(OBJECT(&s->soc[i]), "cpu-type",
                                machine->cpu_type, &error_abort);
        ...

        if (virt_aclint_allowed() && s->have_aclint) {
            if (s->aia_type == VIRT_AIA_TYPE_APLIC_IMSIC) {
                /* Per-socket ACLINT MTIMER */
                riscv_aclint_mtimer_create(s->memmap[VIRT_CLINT].base +
                            i * RISCV_ACLINT_DEFAULT_MTIMER_SIZE,
                            ...);
            } else {
                /* Per-socket ACLINT MSWI, MTIMER, and SSWI */
                riscv_aclint_swi_create(s->memmap[VIRT_CLINT].base +
                            i * s->memmap[VIRT_CLINT].size,
                        base_hartid, hart_count, false);
                riscv_aclint_mtimer_create(s->memmap[VIRT_CLINT].base +
                            i * s->memmap[VIRT_CLINT].size +
                            RISCV_ACLINT_SWI_SIZE,
                            ...);
                riscv_aclint_swi_create(s->memmap[VIRT_ACLINT_SSWI].base +
                            i * s->memmap[VIRT_ACLINT_SSWI].size,
                        base_hartid, hart_count, true);
            }
        } else if (tcg_enabled()) {
            /* Per-socket SiFive CLINT */
        }

        /* Per-socket interrupt controller */
        if (s->aia_type == VIRT_AIA_TYPE_NONE) {
            s->irqchip[i] = virt_create_plic(s->memmap, i,
                                             base_hartid, hart_count);
        } else {
            s->irqchip[i] = virt_create_aia(s->aia_type, s->aia_guests,
                                            s->memmap, i, base_hartid,
                                            hart_count);
        }

        /* Try to use different IRQCHIP instance based device type */
        if (i == 0) {
            mmio_irqchip = s->irqchip[i];
            virtio_irqchip = s->irqchip[i];
            pcie_irqchip = s->irqchip[i];
        }
        ...
    }


    /* register system main memory (actual RAM) */
    memory_region_add_subregion(system_memory, s->memmap[VIRT_DRAM].base,
                                machine->ram);

    /* boot rom */
    memory_region_init_rom(mask_rom, NULL, "riscv_virt_board.mrom",
                           s->memmap[VIRT_MROM].size, &error_fatal);
    memory_region_add_subregion(system_memory, s->memmap[VIRT_MROM].base,
                                mask_rom);

    /* other subsystem initialization */
    ...

    /* machine done */
    s->machine_done.notify = virt_machine_done;
    qemu_add_machine_init_done_notifier(&s->machine_done);
}
```

别看这个函数很长，实际上它做的事情很简单：

```
virt_machine_init()
  → riscv_socket_count()  // 创建 CPU Socket
  → memory_region_init() // 初始化内存区域
  → create_fdt()         // 生成设备树(DTB)
```

CPU socket 主要是可以按照簇（cluster）来创建多组 CPU 核心，然后按照地址空间初始化各种设备，
最后为 virt 在内存中生产一个设备树，方便运行 linux kernel。

那么，是在什么位置加载的 OpenSBI 二进制程序呢？

## 加载客户机程序

有一点可以明确，那么肯定是存储 OpenSBI 的设备模型先被创建并初始化好，才能加载客户机程序二进制
数据进去，按照这个思路，我们可以找到如下代码（实际上 QEMU 是在整个 virt Machine 就绪以后，
才开始加载客户机程序，它被安排在 machine_done 中实现）：

```c
static void virt_machine_done(Notifier *notifier, void *data)
{
    ...
    firmware_end_addr = riscv_find_and_load_firmware(machine, firmware_name,
                                                     &start_addr, NULL);
    ...
}

target_ulong riscv_find_and_load_firmware(MachineState *machine,
                                          const char *default_machine_firmware,
                                          hwaddr *firmware_load_addr,
                                          symbol_fn_t sym_cb)
{
    char *firmware_filename;
    target_ulong firmware_end_addr = *firmware_load_addr;

    firmware_filename = riscv_find_firmware(machine->firmware,
                                            default_machine_firmware);

    if (firmware_filename) {
        /* If not "none" load the firmware */
        firmware_end_addr = riscv_load_firmware(firmware_filename,
                                                firmware_load_addr, sym_cb);
        g_free(firmware_filename);
    }

    return firmware_end_addr;
}

char *riscv_find_firmware(const char *firmware_filename,
                          const char *default_machine_firmware)
{
    char *filename = NULL;

    if ((!firmware_filename) || (!strcmp(firmware_filename, "default"))) {
        /*
         * The user didn't specify -bios, or has specified "-bios default".
         * That means we are going to load the OpenSBI binary included in
         * the QEMU source.
         */
        filename = riscv_find_bios(default_machine_firmware);
    } else if (strcmp(firmware_filename, "none")) {
        filename = riscv_find_bios(firmware_filename);
    }

    return filename;
}
```

可以看到，如果我们默认不指定 -bios，或者 -bios default，那么 QEMU 将默认加载 OpenSBI 二进制数据。


## vCPU 执行的第一条指令

如果你使用 riscv64-gdb 远程连接上 QEMU 以后，你会发现：

```bash
riscv64-elf-gdb -ex "target remote localhost:1234"
0x0000000000001000 in ?? ()
(gdb) display /i $pc
1: x/i $pc
=> 0x1000:      auipc   t0,0x
```

你会发现，vCPU 的第一条指令在 0x1000 这个地址。再往下单步几次，你会发现来到 0x80000000 这个地址，这是 OpenSBI 的第一条指令：

```bash
(gdb) si
0x0000000000001004 in ?? ()
1: x/i $pc
=> 0x1004:      addi    a2,t0,40
(gdb)
0x0000000000001008 in ?? ()
1: x/i $pc
=> 0x1008:      csrr    a0,mhartid
(gdb)
0x000000000000100c in ?? ()
1: x/i $pc
=> 0x100c:      ld      a1,32(t0)
(gdb)
0x0000000000001010 in ?? ()
1: x/i $pc
=> 0x1010:      ld      t0,24(t0)
(gdb)
0x0000000000001014 in ?? ()
1: x/i $pc
=> 0x1014:      jr      t0
(gdb)
0x0000000080000000 in ?? ()
1: x/i $pc
=> 0x80000000:  add     s0,a0,zero
(gdb)
0x0000000080000004 in ?? ()
1: x/i $pc
=> 0x80000004:  add     s1,a1,zero
```

此处对应源码初始化的位置在：

```c
static void riscv_cpu_reset_hold(Object *obj, ResetType type)
{
    ...
#ifndef CONFIG_USER_ONLY
    env->misa_mxl = mcc->def->misa_mxl_max;
    env->priv = PRV_M;
    env->mstatus &= ~(MSTATUS_MIE | MSTATUS_MPRV);
    if (env->misa_mxl > MXL_RV32) {
        /*
         * The reset status of SXL/UXL is undefined, but mstatus is WARL
         * and we must ensure that the value after init is valid for read.
         */
        ...
    }
    env->mcause = 0;
    env->miclaim = MIP_SGEIP;
    env->pc = env->resetvec;  /* resetvec is set in resetvec_cb */
    env->bins = 0;
    env->two_stage_lookup = false;

    ...
}

```
可以看到 env->pc 被赋值为 env->resetvec，而 resetvec 的默认值是：

```
//cpu_bits.h
/* Default Reset Vector address */
#define DEFAULT_RSTVEC      0x1000
```

到这里，我详细你已经掌握了一些分析 QEMU 初始化流程的方法。

!!! note "Task"

    尝试分析 virt Machine 的串口设备模型是如何初始化的，请结合 memory region 分析。
