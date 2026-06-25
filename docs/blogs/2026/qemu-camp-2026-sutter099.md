# QEMU 训练营 2026 专业阶段总结

!!! note "主要贡献者"

    - 作者：[@sutter099](https://github.com/sutter099)

---

## 背景介绍

我是一名应届硕士毕业生，平时对操作系统和芯片架构比较感兴趣。参加这次 QEMU 训练营，一方面是想了解一些虚拟化相关的知识，另一方面也希望借助真实的实验场景，加深自己对 QEMU 代码结构和 RISC-V 软硬件协作方式的理解。

前一段时间因为一些个人原因，训练营内容的推进速度稍慢。现在撰写这篇博客时，我更希望将学习过程中的核心理解与技术细节整理清楚。

## 专业阶段

CPU & SoC

### CPU 实验

**TCG: Tiny Code Generator**

TCG 本质上是一套动态翻译/JIT 机制：它把 guest CPU 指令实时翻译成 QEMU 的中间表示，再生成宿主机可以直接执行的机器码。这样一来，QEMU 就不只是“模拟器”，而是一个可以把目标架构指令转换成本机指令的执行框架。它最早是一个 GCC 后端，现在逐渐演化成 qemu 的加速器之一

#### TCG 前端与后端

**前端**：负责 Guest 指令的**语义化解析**。

* RISC-V 的前端入口位于 `target/riscv/translate.c:riscv_translate_code()`。
* 在主循环 `translate_loop()` 中，每条指令通过 `ops->translate_insn(db, cpu)` 进行翻译。对于 RISC-V 架构，该函数指针指向 `riscv_tr_translate_insn`。
* 在 `riscv_tr_translate_insn()` 内部会调用 `decode_opc()` 对指令进行解码。其中，32 位指令的解码来自 `target/riscv/insn32.decode` 编译生成的 `decode_insn32`，匹配命中后会调用对应的 `trans_*` 函数。
* **`decodetree` 机制**：`.decode` 文件是开发者编写的声明式描述，`decodetree.py` 脚本读取它并生成 `.c.inc` 格式的解码文件，在编译时直接插入到 C 源码中。


**后端**：负责实现从 TCG IR 到 Host 机器码的**翻译与发射**。

* TCG 操作码（Opcode）定义在 `include/tcg/tcg-opc.h`。
* 通用代码生成入口位于 `tcg/tcg.c:tcg_gen_code()`，各个 Host 架构的指令发射器实现于 `tcg/<host>/tcg-target.c.inc`。
* 翻译块（TB，Translation Block）的生成最终由 `accel/tcg/translate-all.c:tb_gen_code()` 完成。

#### 示例：`add x5, x6, x7` 的翻译流程

```
add x5, x6, x7  (0x007302B3)
│
▼  decode_insn32() 匹配 opcode → funct3 → funct7
│
▼  decode_insn32_extract_r() 提取字段
│  → arg_r { .rd=5, .rs1=6, .rs2=7 }
│
▼  trans_add(ctx, &arg_r)
│  → gen_arith() → tcg_gen_add_tl(dest, src1, src2)
│
▼  TCG 后端编译为 host 指令并执行
```

#### example: 支持 cube 指令

##### Helper 实现

分为四步：

1. 在 `.decode` 文件中定义 cube 指令的二进制格式
2. 在 helper.h 中声明 cube helper 函数
3. 在 `op_helper.c` 中定义 cube helper 函数
4. 在 `.c.inc` 文件的 `trans_cube` 函数中使用 helper

##### TCG 实现

分为两步：

1. 在 `.decode` 文件中定义 cube 指令的二进制格式
2. 在 `.c.inc` 文件 `trans_cube` 函数中使用 TCG IR 实现 cube 操作

### SoC 实验

如果说 CPU 方向让我理解的是“指令怎么跑”，那 SoC 方向让我理解的是虚拟硬件是怎么搭出来的。

#### 几个重要的概念

当我们使用 QEMU 命令行时，`-machine` 参数决定了主板的骨架，`-cpu` 决定了处理器模型。参数解析完毕后，QEMU 会实例化 `MachineState`，并在初始化阶段调用 `mc->init()`。

在 qemu 设备建模过程中，有几个至关重要的概念需要厘清：

- MachineClass / TypeInfo
- MachineState
- class_init / instance_init / realize
- 设备注册、MMIO 映射、中断连接

在 qemu 中新建一个机器类型，就需要创建对应的 QOM，MachineClass, MachineState 以及相关的初始化函数。

属于机器的方法和静态元数据会放到 `MachineClass` 中。属于机器的动态数据和运行状态，则会放到 `MachineState` 结构体中。

需要实现的初始化相关函数：
- class_init：定义这个类的蓝图；
- instance_init：给实例准备默认状态；
- realize：等属性都确定后，真正把设备挂到板子上；
- board init：把 CPU、内存、总线、外设、中断关系串起来。

**example**

假设我们运行了 `qemu-system-x86_64 -m 2G -M q35`：

1. **编译与注册阶段**：QEMU 源码中 `hw/i386/pc_q35.c` 里的 `TypeInfo` 结构体通过 `type_init()` 宏被注册进 QEMU 系统。
2. **类初始化**：QEMU 启动时解析到 `-M q35`，找到对应的 `TypeInfo`，为其分配并创建 `MachineClass`，并调用 `class_init` 填充好虚函数（比如将 `mc->init` 指向 `pc_q35_init`）。
3. **实例创建**：QEMU 分配一个 `MachineState`结构体空间。
4. **属性解析**：解析 `-m 2G`，将内存大小等参数写入这个 `MachineState` 实例中。
5. **启动机器**：最终，QEMU 调用 `MachineClass->init(MachineState)`。在这个 `init` 函数中，QEMU 会读取 `MachineState` 里的配置（如 2G 内存、CPU 数量），开始真正的硬件模拟初始化。

#### G233 机器类型

`hw/riscv/g233.c` 实现了 `g233` 机器类型。定义了虚拟硬件布局。

硬件设备包括：

- CPU/内存
- 中断：PLIC, CLINT/ACLINT, APLIC/IMSIC
- 外设
- UART
- PCIe host
- VirtIO MMIO slots
- Goldfish RTC
- Dual CFI Flash
- Syscon poweroff/reset

machine 初始化中包含了 `class_init` 以及 `instance_init`。

`class_init` 中设置了 `MachineClass` 对象，设置了 `MachineClass->init()` 函数，这个函数初始化每个 cpu、创建中断，设置 SoC 内部硬件布局

`instance_init` 中初始化了机器的状态`RISCVG233State`

> 前端模拟是 QEMU 向虚拟机 Guest OS 呈现的虚拟硬件设备，包括设备的寄存器接口、中断线、MMIO 地址空间和 DMA 能力，让 Guest 认为自己在与真实硬件交互。
> 后端模拟是 QEMU 在宿主机侧处理 Guest IO 请求的真实资源实现。

#### g233_pwm

代码分成三部分

1. QOM 骨架
2. MMIO
3. 时钟更新与中断触发

**QOM 骨架**

参考 g233_gpio.c 完成，class_init 注册类型，instance_init 注册总线、MMIO、irq 等，realize 注册回调。除此之外，再完成 build 选项 (Kconfig, meson.build) 以及 g233.c 中的地址空间分配、设备创建、fdt 创建。

**MMIO**

注册 read/write 两个函数，读写寄存器，增加修改寄存器后的副作用 (硬件行为)

**时钟更新与中断触发**

duty, period, cnt 的关系：

1. duty < period
2. 当 cnt 计数达到 duty 后进入低电平，当 cnt 计数达到 period 后触发中断。

#### g233_wdt

`val`寄存器中的值随时间递减。
喂狗时，`val`寄存器重置为`load`

#### spi

在完成 spi 实验时，参考了 ASPEED 的 spi 结构：

```
+-------------------------------------------+
|             CPU / System Bus              |
+-------------------------------------------+
  |                       |
(MMIO R/W)      |                       | (AHB Memory R/W)
Control Regs      |                       | Flash Data Window
  V                       V
+===================================================================================+
|                                  AspeedSMCState                                   |
|                                                                                   |
|  +--------------------------+                     +----------------------------+  |
|  |     寄存器访问接口       |                     |     Flash 内存映射窗口     |  |
|  | (aspeed_smc_read/write)  |                     | (aspeed_smc_flash_read/    |  |
|  |                          |                     |  aspeed_smc_flash_write)   |  |
|  | [0x00] 配置寄存器        |   控制工作模式      |                            |  |
|  | [0x04] CE 控制寄存器     | ------------------> |  将 CPU 的直接内存读写     |  |
|  | [0x10] CEx 控制寄存器    |                     |  动态翻译为 SPI 读写时序   |  |
|  | [0x..] 其他状态寄存器    |                     |                            |  |
|  +--------------------------+                     +----------------------------+  |
|               |                                                 |                 |
|               +----------------------+--------------------------+                 |
|                                      |                                            |
|                          +-----------------------+                                |
|                          |    SPI 核心序控器     | <--- AspeedSMCFlash (0..N)     |
|                          |  (SPI Core Sequencer) |      保存每个 CS 的起始地址、  |
|                          |                       |      模式(User/Normal)等上下文 |
|                          +-----------------------+                                |
|    (qdev_set_irq / GPIO)       |           |   (ssi_transfer / SSI Bus)           |
|  +-----------------------------+           +-----------------------------------+  |
|  | CS0 | CS1 | ... | CSn     |           |        MOSI / MISO / CLK          |  |
+==|=====|===========|=======|===============|===================================|==+
|     |           |       |               |                 |                 |
v     v           v       v               v                 v                 v
+---------+      +---------+          +-----------+     +-----------+     +-----------+
|  Flash  |      |  Flash  |          | Flash 0   |     | Flash 1   |     | Flash N   |
|  CS 0   |      |  CS 1   |   ...    | (m25p80)  |     | (m25p80)  | ... | (m25p80)  |
| (GPIO)  |      | (GPIO)  |          | SPI Data  |     | SPI Data  |     | SPI Data  |
+---------+      +---------+          +-----------+     +-----------+     +-----------+

```

spi 的接收和发送是同时发生的，当发生了一个 transmit，要设置缓冲区空以及接收区非空的标志。

#### 问题记录

**如何支持一个新的外设？**

参考现有的设备

- QOM 注册类型，并定义变体
- 状态结构中保存寄存器、FIFO、IRQ、时钟
- instance_init 配置 MMIO/IRQ/时钟
- realize 绑定 chardev 回调
- MMIO 读写驱动寄存器与 FIFO
- 机型侧完成地址映射与中断连接

外设建模过程
https://qemu.gevico.online/tutorial/2026/ch2/qemu-hw/

**三个 init 函数的作用**

- **class_init** (e.g. `virt_machine_class_init`)

执行时间：每个 type 都会注册一个 class_init，在 QEMU 启动时注册类型，所有的 class_init 都通过链表组织

作用：它用于定义“蓝图”

此时还不存在设备

- **instance_init** (e.g. `virt_machine_instance_init`)

执行时间：它是每个对象创建的第一步，在用户的 CLI 参数被应用之前

作用：给特定的板级对象设置默认状态

- **MachineClass->init** (e.g. `virt_machine_init`)

执行时间：在用户 CLI 参数被解析后

作用：实际构建了板级模型，分配内存，创建 cpu，设置中断等

| **特性**     | **class_init** | **instance_init** | **realize**                 |
| ---------- | -------------- | ----------------- | --------------------------- |
| **执行频次**   | 每类（Class）一次    | 每实例（Instance）一次   | 每实例一次                       |
| **执行前置条件** | 类的首次加载         | 对象内存分配后           | 所有外部属性被赋值后                  |
| **是否允许失败** | 否（不可中断）        | 否（返回 `void`）      | **是**（通过 `Error **errp` 报错） |
| **主要操作对象** | 虚函数表、类元数据      | 内部数据、子组件、默认状态     | 系统总线、外部后端、MMIO/IRQ          |

**中断的输出有几种形式？**

在 QEMU 硬件模拟中，中断（或者说硬件信号的输出）主要分为两种：

*   传统线中断（Wire IRQ / Pin）：通过 qemu_irq 模拟真实的物理导线电平变化。这是最常见的形式，调用 `qemu_set_irq(irq, level) `来改变电平（0 变 1，或 1 变 0）。PL011、各种 GPIO 模块发给 CPU PLIC 的中断都属于这种。
*   消息信号中断（MSI / MSI-X）：常见于 PCI/PCIe 设备。它不是通过专门的物理线，而是设备直接向特定的内存地址（如 APIC/IMSIC 地址）发起一次 DMA 内存写入操作来触发中断。

**中断的输入有几种形式？**

设备接收外部硬件信号（输入）主要对应上面的第一种：

*   作为 SysBus 设备接收中断线：如果你的设备是中断控制器（比如 PLIC），它会暴露出很多“输入引脚”供其他外设连接（使用 qdev_init_gpio_in 注册回调函数接收电平跳变事件）。
*   通过内存映射监听 MSI：如果你的设备是 IMSIC 等高级中断控制器，它的“输入”其实就是监听别人往它的 MMIO 寄存器里“写数据”。

**qdev_init_gpio_in / qdev_init_gpio_out 的作用**

*   `qdev_init_gpio_in(dev, handler, n)`：为设备暴露 n 个匿名的输入引脚。当外部通过连线改变了这根引脚的电平，QEMU 会自动调用我们注册的 handler 函数（在我们的例子里就是 g233_gpio_set）。
*   `qdev_init_gpio_out(dev, pins, n)`：为设备申请 n 个匿名的输出引脚，并将它们绑定到你的 qemu_irq 数组 pins 上。你可以通过 `qemu_set_irq(pins[i], 1) `来驱动连在这个引脚上的下游设备。

**写好的 g233_gpio 怎么注册到 g233 board 中**

注册过程通过 `sysbus_create_simple("g233_gpio", base_addr, irq) `函数实现。这个函数在底层做了三件事：

1. 实例化 TYPE_G233_GPIO 这个类（调用其 realize）。
2. 把它的 mmio 区域映射到物理地址 base_addr（如 0x10012000）。
3.  连接中断线：把 qdev_get_gpio_in(mmio_irqchip, GPIO_IRQ) 作为第三个参数传给上面。这相当于拿了一根“虚拟导线”，把 g233_gpio 的 sysbus_init_irq  的输出端，和 PLIC（mmio_irqchip）的 GPIO_IRQ 号输入管脚相连接了。

**qemu_fdt_setprop_cells(ms->fdt, name, "interrupts", GPIO_IRQ, 0x4) 中的 0x4 作用**

在 Device Tree 的中断绑定规范中，第二个单元（Cell）通常用来描述触发类型（Trigger Type）。
在 RISC-V PLIC 的标准里：

*   0x1：上升沿触发 (Edge-Rising)
*   0x4：高电平触发 (Level-High)

由于在 QEMU 内部我们的 s->irq 通常只用 0 和 1 代表低/高电平，这里标明 0x4 是告诉 Guest OS：“这个 GPIO 的综合中断是以高电平持续有效的形式发送给 PLIC 的”。

**deposit32 以及 extract32 的作用是什么**

它们是 QEMU 提供的位操作安全宏。

*   extract32(value, start, length)：从 value 的第 start 位开始，连续提取 length 个比特，并把它移到最低位返回。
*   deposit32(value, start, length, fieldval)：把 fieldval 的低 length 位，安全地塞进 value 的第 start 位开始的位置中，并保持 value 其他位不变，返回新值。
这比手写 (val & ~(mask << shift)) | (new_val << shift) 这种位运算更安全。

**总结编写 gpio device model 过程中使用的重要 API**

1.  QOM 框架：DECLARE_INSTANCE_CHECKER, type_init, device_class_set_props（声明类和属性）。
2.  系统总线与内存：memory_region_init_io（绑定读写回调），sysbus_init_mmio（暴露内存）。
3.  中断与连线：sysbus_init_irq（向上级控制器暴露中断输出），qdev_init_gpio_in/out（与平级外部设备交换电平），qemu_set_irq（发送电平变化）。
4.  状态保存：VMSTATE_UINT32（用于 QEMU 休眠/快照时保存现场）。

**qemu fdt 的作用是什么？**

Flattened Device Tree (FDT) 是嵌入式 Linux 启动的核心。
在没有 ACPI 的 RISC-V 和 ARM 世界，CPU 刚上电时对周围的外设一无所知。QEMU 动态拼接出一个 FDT，在启动前把它放进某块约定好的内存里。内核启动时，顺着 FDT，动态发现内存和外设的布局，从而动态挂载相应的驱动。

### 使用 qemu 调试 linux 内核

**为什么**

> 搭建一个零成本、可重复、安全的内核调试环境，不需要真实硬件，不怕损坏系统

**优势分析**

| 方法              | 优势          | 劣势          |
| --------------- | ----------- | ----------- |
| printk<br>      | 简单          | 重编译，能使用的场景少 |
| ftrace<br>      | 动态，无需重编译    | 学习难         |
| GDB + QEMU      | 源码级调试       | 需要虚拟化环境？    |
| crash / kdump   | 事后 coredump | 仅限崩溃        |
| /proc, /sys<br> | 运行时观察       | 粗粒度         |

**配置**

```
# 保留调试符号
CONFIG_DEBUG_INFO=y
CONFIG_DEBUG_INFO_DWARF5=y

# 禁用地址随机化，方便断点
CONFIG_RANDOMIZE_BASE=n

# GDB 辅助脚本
CONFIG_GDB_SCRIPTS=y

# 保留帧指针
CONFIG_FRAME_POINTER=y

# 防止变量被优化掉
CONFIG_CC_OPTIMIZE_FOR_SIZE=y
```

启动参数
```
-append "console=ttyS0 rdinit=/init nokaslr"
```

`-s` --> `-gdb tcp::1234`
`-S` 启动后暂停 CPU，等待 gdb 连接

qemu 中实现了一个 gdb server

> 在内核压缩、MMU 启动后，需要对符号重定向才能对应上代码

**调试内核模块**

内核模块是动态加载的，qemu 不知道它的符号地址

两步找到符号地址：

1. `/sys/module/mini_rdma/sections/.text` 文件中找到模块加载地址
2. 在 gdb 中加载模块符号

```
add-symbol-file mini_rdma/mini_rdma.ko <address_found_in_step1>
```

gdb 中查看设备结构体与自定义结构体（可以用括号做类型强转）

**内核 GDB 调试脚本**

加载内核辅助脚本
```
add-auto-load-safe-path /path/to/kernel/gdb/scripts

source kernel/vmlinux-gdb.py
```

**常用命令**

| 常用命令                        | 作用          |
| --------------------------- | ----------- |
| lx-dmesg                    | 查看 dmesg 日志 |
| lx-lsmod                    | 列出模块        |
| lx-ps                       | 列出进程        |
| lx-cmdline                  | 内核命令行       |
| lx-cpus                     | CPU 信息      |
| lx-mount                    | 挂载点         |
| lx-iomem                    | IO 内存映射     |
| lx-device-list-bus bus_type | 设备列表        |

能直接读内核数据结构，信息比 `/proc` 更多

**条件断点**

创建断点时添加条件

```
b main.c:45 if i > 100
b func if argc == 3
```

给现有断点添加条件

```
(gdb) info break  # 查看断点编号，如Breakpoint 1
(gdb) condition 1 num == 5  # 只在num=5时触发
(gdb) condition 1  # 删除条件，变回普通断点
```

其他技巧

- 多条件：`b 30 if (x > 10 && y < 20)`
- 内核参数：`b func_a if arg1 > 0`
- 内存地址：`watch *0x7fff5fbff000 if *(int*)0x7fff5fbff000 == 42`
- 临时断点：`tbreak start_kernel`
- 忽略 100 次触发：`ignore 1 100`

> 用硬件断点`hbreak`或数据监视点`watch if`可以优化性能

> 硬件断点使用 CPU 的 4 个调试寄存器（x86），数据监视点也利用 CPU 硬件监控数据访问

**命令**

- `finish` 执行到当前函数返回
- `until <line_number>` 执行到指定行
- `bt` 调用栈
- `i locals` 查看局部变量
- `i registers` 查看寄存器
- `x/16xg $rsp` 查看内存
- `disassemble /s` 反汇编

## 总结

我觉得在学习阶段，有意识地少用 ai coding 是好的，因为目的是学习，可以亲手码一码，印象会更深。

## 参考资料

* QEMU 主板建模流程： [https://qemu.gevico.online/tutorial/2026/ch2/qemu-machine/](https://qemu.gevico.online/tutorial/2026/ch2/qemu-machine/)
* QOM 深度解析博客： [https://martins3.github.io/qemu/qom.html](https://martins3.github.io/qemu/qom.html)
* QEMU 官方 qdev API 文档： [https://www.qemu.org/docs/master/devel/qdev-api.html](https://www.qemu.org/docs/master/devel/qdev-api.html)
* Airbus Seclab QEMU 技术博客： [https://github.com/airbus-seclab/qemu_blog](https://github.com/airbus-seclab/qemu_blog)
* 【QEMU 训练营 | 基于 QEMU 调试 Linux 内核手把手教学】： [https://www.bilibili.com/video/BV14NAPzjEPW/](https://www.bilibili.com/video/BV14NAPzjEPW/)
