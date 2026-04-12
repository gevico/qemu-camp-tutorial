# QEMU 启动参数分析

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

!!! info "QEMU 版本"

    本文基于 QEMU **v10.2.0**（tag: [`v10.2.0`](https://gitlab.com/qemu-project/qemu/-/tags/v10.2.0)，commit: `75eb8d57c6b9`）。

QEMU 是一款功能强大的开源虚拟化和仿真软件，支持多种处理器架构（x86、ARM、RISC-V、MIPS、Loongarch 等）。通过 QEMU，开发者可以在不同的硬件平台上测试操作系统、运行应用程序、进行内核开发和调试。

本章节将聚焦 QEMU 常用启动参数，以启动 OpenEuler RISC-V 系统为实例，重点讲解主板选型、CPU 配置、设备添加等核心操作，进而介绍如何精准查找适配自身需求的 QEMU 启动参数，抛砖引玉助力读者掌握相关应用方法。


!!! tip "概览"

    - 启动参数分类与常用选项速查
    - OpenEuler RISC-V 启动示例
    - 配置文件与启动脚本的组织方式
    - 查阅与定位合适的 QEMU 启动参数

## 常用参数速查

大体上 QEMU 常用的启动参数可以分为五类：主板配置参数、引导参数、存储设备参数、网络参数、显示和交互参数。考虑 QEMU 的启动参数众多，不建议大家死记硬背，而是常用常新，可以将本文作为手册，需要的时候查询一下即可。

下面我们通过表格来介绍，主要罗列适用于 `qemu-system-*`（`*` 代表目标架构，如 `qemu-system-riscv64`、`qemu-system-aarch64` 等）的启动参数。

**主板配置参数**：

|       parameter       |   example   |     Description    |
|          ---          |     ----    |        ----        |
|  `-machine` or `-M`   | `-M virt`   | 选择机器或者主板的类型（`virt` 是 QEMU 提供的通用虚拟主板，不对应真实硬件，专为虚拟化场景设计）， `-M help` 可查询支持的主板 |
|  `-cpu`               | `-cpu rv64` | 选择 CPU 模型， `-cpu help` 可查询支持的 CPU 模型 |
|  `-m`                 | `-m 2G`     | 设置内存大小，支持 M/G 单位，如 2048M |
|  `-smp`               | `-smp 4`    | 配置 CPU 核心数/线程数 |
|  `-device`            | `-device virtio-blk-device`    | 添加新设备，只要当前主板支持 |

**引导参数**：

|       parameter       |          example          |     Description    |
|          ---          |           ----            |        ----        |
|  `-bios`              | `-bios opensbi.bin`       | 加载自定义 BIOS 或 OpenSBI 固件或裸机程序 |
|  `-kernel`            | `-kernel Image`           | 直接加载 Linux 内核镜像（direct Linux boot；不同架构常见镜像名不同，例如 x86 常见 `bzImage`，ARM/RISC-V 常见 `Image`） |
|  `-initrd`            | `-initrd initrd.img`      | 指定初始化内存盘，加载 initramfs 或 initrd 文件系统 |
|  `-append`            | `-append "console=ttyS0"` | 传递给内核的命令行参数（direct Linux boot 场景，通常与 `-kernel` 配合使用） |
|  `-dtb`               | `-dtb kernel.dtb`         | 传递给内核的 DTB（Device Tree Blob，设备树二进制文件，用于描述硬件拓扑，供内核发现和配置设备）镜像文件 |


**存储设备参数**：

|       parameter       |          example          |     Description    |
|          ---          |           ----            |        ----        |
|  `-drive`             | `-drive file=image.qcow2,format=qcow2,if=virtio` | 添加块设备（硬盘、光盘等）|


**网络参数**：

|   parameter  |          example          |     Description    |
|      ---     |           ----            |        ----        |
| `-netdev`    | `-netdev user,id=net0,hostfwd=tcp::2222-:22` | 定义网络后端，用户模式网络、TAP 设备 |

**显示和交互参数**：

|   parameter  |     example     |     Description    |
|      ---     |      ----       |        ----        |
| `-nographic` |        -        | 禁用图形输出，并将串口 I/O（以及默认 monitor）重定向到当前终端；默认转义键为 `Ctrl+a`，可用 `Ctrl+a c` 在串口/monitor 间切换，`Ctrl+a x` 退出，`Ctrl+a h` 查看帮助 |
| `-serial`    | `-serial stdio` | 将 guest 串口重定向到宿主字符设备（常见：`stdio`、`mon:stdio`、`file:run.log` 等） |
| `-monitor`   | `-monitor none` | 重定向或禁用 HMP monitor；例如 `-monitor stdio` 将 monitor 放到当前终端，`-monitor none` 禁用默认 monitor |
| `-s`         |        -        | 启用 gdbstub（QEMU 内置的 GDB 远程调试服务端，等价于 `-gdb tcp::1234`） |
| `-S`         |        -        | 启动时冻结 CPU，等待 gdb/monitor 继续执行 |

---

## OpenEuler 启动示例

了解了常用参数的含义后，接下来我们用一个实际例子来演示如何组合这些参数启动一个真实的操作系统。

我们以 OpenEuler RISC-V 24.03 为例进行介绍，获取相关镜像的方式如下：

```bash
wget https://mirror.nyist.edu.cn/openeuler/openEuler-24.03-LTS-SP2/virtual_machine_img/riscv64/RISCV_VIRT_CODE.fd
wget https://mirror.nyist.edu.cn/openeuler/openEuler-24.03-LTS-SP2/virtual_machine_img/riscv64/RISCV_VIRT_VARS.fd
wget https://mirror.nyist.edu.cn/openeuler/openEuler-24.03-LTS-SP2/virtual_machine_img/riscv64/start_vm.sh
wget https://mirror.nyist.edu.cn/openeuler/openEuler-24.03-LTS-SP2/virtual_machine_img/riscv64/openEuler-24.03-LTS-SP2-riscv64.qcow2.xz
```

其中 `start_vm.sh` 里面包含了 QEMU 启动 OpenEuler 的参数，我们摘出来详细介绍一下：

```bash

## Configuration
vcpu=8
memory=8
drive="$(ls *.qcow2)"
fw1="RISCV_VIRT_CODE.fd"
fw2="RISCV_VIRT_VARS.fd"
ssh_port=12055

cmd="qemu-system-riscv64 \
  -nographic -machine virt,pflash0=pflash0,pflash1=pflash1,acpi=off \
  -smp "$vcpu" -m "$memory"G \
  -blockdev node-name=pflash0,driver=file,read-only=on,filename="$fw1" \
  -blockdev node-name=pflash1,driver=file,filename="$fw2" \
  -drive file="$drive",format=qcow2,id=hd0,if=none \
  -object rng-random,filename=/dev/urandom,id=rng0 \
  -device virtio-vga \
  -device virtio-rng-device,rng=rng0 \
  -device virtio-blk-device,drive=hd0 \
  -device virtio-net-device,netdev=usernet \
  -netdev user,id=usernet,hostfwd=tcp::"$ssh_port"-:22 \
  -device qemu-xhci -usb -device usb-kbd -device usb-tablet"
```

我们挑选几个前面没有介绍到的参数，来补充说明一下。这个启动脚本使用了大量 VirtIO 设备——VirtIO 是一套专为虚拟化环境设计的 I/O 标准，客户机通过 VirtIO 驱动与宿主机高效通信，避免了模拟传统硬件的开销。

`-machine virt,pflash0=pflash0,pflash1=pflash1,acpi=off`：选择 RISC-V 的 virt 虚拟主板；把名为 pflash0/pflash1 的块设备节点挂到主板的两片 pflash（Parallel Flash，并行闪存，用于存放固件代码和变量）；关闭 ACPI。

`-blockdev node-name=pflash0,driver=file,read-only=on,filename="$fw1"`：创建名为 pflash0 的块设备后端，来源是文件 fw1，并设为只读（固件代码）。

`-blockdev node-name=pflash1,driver=file,filename="$fw2"`：创建名为 pflash1 的块设备后端，来源是文件 fw2（变量区，默认可写）。

`-drive file="$drive",format=qcow2,id=hd0,if=none`：定义一个 qcow2 磁盘为 hd0；if=none 表示只创建驱动器对象，不自动挂到任何总线上（后面再用 -device 手动挂载）。

`-device virtio-blk-device,drive=hd0`：把 hd0 作为 VirtIO 块设备挂到虚拟机上（通常会出现在 guest 里为 /dev/vda 一类）。

`-object rng-random,filename=/dev/urandom,id=rng0`：创建随机数后端 rng0，从主机 /dev/urandom 取随机数据。

`-device virtio-rng-device,rng=rng0`：把随机数后端通过 VirtIO RNG 设备提供给虚拟机。

`-device virtio-net-device,netdev=usernet`：添加一块 VirtIO 网卡，并绑定到 usernet 这个网络后端。

`-device virtio-vga`：添加 VirtIO 显示设备。使用 `-nographic` 时不会打开图形窗口，但该设备仍会被固件/操作系统枚举。

`-device qemu-xhci`：添加 xHCI 控制器。

`-usb -device usb-kbd`：开启 USB 支持，添加 USB 键盘设备。

`-device usb-tablet`：添加 USB 平板指针设备（绝对坐标，常用于图形界面以改善指针定位；纯串口交互场景一般不需要）。

现在我们解压镜像，启动 OpenEuler:

```bash
unxz -k openEuler-24.03-LTS-SP2-riscv64.qcow2.xz

chmod +x start_vm.sh
./start_vm.sh
```

## 查阅 QEMU 启动参数

!!! tip "查阅方法"

    这里提供几个方法。

    方法一：通过 `--help` / `help` 子命令查询（输出会随 QEMU 版本与架构变化）：

    ```bash
    qemu-system-riscv64 --help
    qemu-system-riscv64 -machine help
    qemu-system-riscv64 -cpu help
    qemu-system-riscv64 -device help
    qemu-system-riscv64 -device virtio-blk-device,help
    ```

    方法二：通过训练营提供的 QEMU 知识库，检索需要的启动参数 [ima 知识库: QEMU | 格维开源社区][qemu-ima-link]

    方法三：官方资料（用于校对参数语义）：

    - Direct Linux Boot:<https://www.qemu.org/docs/master/system/linuxboot.html>
    - GDB usage:<https://www.qemu.org/docs/master/system/gdb.html>
    - Keys in the character backend multiplexer:<https://www.qemu.org/docs/master/system/mux-chardev.html>
    - QEMU User Documentation:<https://www.qemu.org/docs/master/system/qemu-manpage.html>

[qemu-ima-link]: https://ima.qq.com/wiki/?shareId=70cb647d4024402dccc94b947c210de2e5c65c68559c166da7ee1a3d9a714e5e
