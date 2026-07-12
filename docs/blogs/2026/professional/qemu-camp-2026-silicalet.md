# QEMU 训练营 2026 专业阶段总结

!!! note "主要贡献者"

    - 作者：[@silicalet](https://github.com/silicalet)

---

## 背景介绍

我参加 QEMU 训练营，希望把过去在 Rust 和操作系统练习中接触到的系统编程知识，进一步落实到真实的大型工程中。QEMU 同时涉及体系结构、设备模型、总线、中断和测试框架，正适合用来理解软件如何描述硬件行为。

专业阶段共有 CPU、SoC、GPGPU 和 Rust 四个方向。我完成了 GPGPU 与 Rust 两个方向：前者从 PCIe 设备模型一直深入到一个简化的 SIMT 执行引擎，后者则围绕 I2C、SPI 总线与外设建模展开。两个方向看似不同，实际都要求把硬件手册中的寄存器和协议语义，转换成可测试的状态机。

## 专业阶段

### GPGPU 方向

GPGPU 方向的目标是在 QEMU 中实现一块教学用 PCIe 加速器。实验包含 10 组任务、17 个 QTest 测例，覆盖设备标识、控制寄存器、VRAM、DMA、中断、SIMT 上下文、RV32I/RV32F kernel 执行和低精度浮点转换。

#### PCI 设备、MMIO 与状态管理

设备向客户机暴露控制寄存器、VRAM 和 doorbell 三类 BAR。我的实现首先补全 `gpgpu_ctrl_read` 与 `gpgpu_ctrl_write`，按照寄存器偏移维护设备使能、运行状态、错误状态、IRQ、kernel 参数、DMA 参数和 SIMT 上下文。

这里最重要的不是让寄存器“可以读写”，而是保持状态间的约束。例如，只有设备已使能且不处于 `BUSY` 时才能接受 dispatch；软复位需要同时清理 kernel、DMA、SIMT 和中断状态；IRQ ACK 则采用 write-one-to-clear 语义，并在状态变化后重新计算 INTx 电平。

中断路径同时考虑了 MSI-X、MSI 和传统 INTx。事件发生时先写入 `irq_status`，再与 `irq_enable` 相与；只有对应事件已使能时，才根据当前 PCI 中断模式发送通知。这样 kernel 完成、DMA 完成和错误事件可以共用一套状态更新逻辑。

#### VRAM 与 DMA

BAR2 对应 64 MiB VRAM。直接访问通过小端加载、存储函数完成，并在读写前检查 `addr + size` 是否越界。越界时不继续访问，而是设置 VRAM fault 和全局错误状态，并触发错误中断。

DMA 则连接客户机内存与设备 VRAM。根据方向位选择 `pci_dma_read` 或 `pci_dma_write`，同时分别检查 VRAM 范围和 QEMU `MemTxResult`。传输成功后清除 `BUSY`、置位 `COMPLETE`，并按配置产生 DMA 完成中断；失败时进入统一的错误路径。这个过程让我更直观地理解了 MMIO 与 DMA 的区别：MMIO 是 CPU 主动访问设备窗口，DMA 是设备模型主动访问客户机地址空间。

#### SIMT 与 kernel 解释执行

后半部分实现了一个简化的 SIMT 执行引擎。Grid 被拆分为 Block，Block 再拆分为 Warp；每个 Warp 包含 32 个 Lane，每个 Lane 保存独立的整数寄存器、浮点寄存器、PC 和执行状态。初始化时根据 block、warp 和 lane 编号生成线程上下文，执行时由 active mask 控制哪些 Lane 参与当前指令。

RV32I 解释器支持测试 kernel 所需的立即数、算术、访存、分支和系统指令。`mhartid` 被编码为 block、warp 和 lane 信息，因此 kernel 可以从同一段指令流中取得自己的线程编号。Warp 循环逐条取指并执行，遇到 `ebreak` 后停止；任一非法指令或 VRAM 越界都会让 kernel 失败，并沿设备层的错误状态与中断路径反馈。

在整数 kernel 之外，我还补充了 RV32F 指令，包括 `fadd.s`、`fmul.s`、整数与单精度浮点转换等。低精度部分实现了 BF16、FP8 E4M3/E5M2 和 FP4 E2M1 的转换与饱和行为。这里容易忽略的是舍入与范围边界：BF16 不能只截断低 16 位，而需要处理 round-to-nearest-even；FP8/FP4 转换也必须按格式最大值执行饱和。

GPGPU 实验让我把一条完整链路串了起来：QTest 写入 BAR 寄存器，设备状态机接收 dispatch，SIMT 引擎执行 VRAM 中的 kernel，最后更新状态并产生中断。相比只实现一个孤立外设，这部分更接近一个小型处理器的建模过程。

### Rust 方向

Rust 方向围绕 G233 SoC 上的 I2C 与 SPI 外设展开，测评由 3 个 Rust 单元测试和 7 个 QTest 组成。实现既要处理 Rust 内部的数据结构和 trait，也要通过 QEMU Rust 绑定接入 QOM、SysBus、MMIO 和中断系统。

#### I2C 总线抽象

I2C 总线部分以 `I2CSlave` trait 表示从设备能力，包括地址、事件、发送和接收操作；`I2CBus` 则保存挂载设备与当前事务状态。`attach` 负责接入从设备，`start_transfer` 按 7 位地址匹配设备并发送 `StartSend` 或 `StartRecv` 事件，`send`、`recv` 将数据转发给当前设备，`end_transfer` 发送 `Finish` 并释放总线。

这层抽象将“控制器如何由 MMIO 驱动”与“从设备如何响应 I2C 事务”分开。不存在目标地址时返回 NACK；存在目标时，总线记录当前地址和方向，后续字节传输不需要重复查找协议状态。Rust 单元测试分别验证设备挂载、EEPROM 读写和 NACK 路径。

#### Rust SysBus I2C 控制器

GPIO-I2C 控制器使用 Rust 实现为 `SysBusDevice`。设备在实例初始化时创建 `MemoryRegion` 和中断源，在 post-init 阶段注册 MMIO 与 IRQ，并通过导出的 C ABI 创建函数挂载到 G233 SoC 的 `0x10013000` 地址。

控制器内部维护 `CTRL`、`STATUS`、`ADDR`、`DATA`、`PRESCALE` 寄存器，以及一个 256 字节的 AT24C02 EEPROM 状态。写 `CTRL` 后，状态机按照 `EN`、`START`、`STOP` 和 `RW` 位推进事务，并同步 `BUSY`、`ACK`、`DONE`。EEPROM 写事务的第一个数据字节作为地址，后续字节写入存储区；页写使用 8 字节页内回绕，读事务则从当前指针连续取数。

这部分让我熟悉了 QEMU Rust 设备模型的基本组成：QOM 对象派生、父对象字段、BQL 下的内部可变性、`MemoryRegionOps` 回调、reset 生命周期，以及 Rust 对象如何通过 FFI 进入现有的 C machine 初始化流程。Rust 能保证大部分内部状态访问的类型与所有权约束，但设备框架边界仍不可避免地需要 `unsafe`，因此把不安全代码限制在初始化和 FFI 接口附近尤其重要。

#### SPI 与 AT25 状态机

SPI 部分实现了控制、状态、数据和片选寄存器，并为 AT25 风格 EEPROM 建立命令状态机。控制器仅在 `SPE` 与 `MSTR` 同时置位时传输；写数据寄存器后更新 `TXE`、`RXNE`，未读取旧数据又发生新传输时设置 `OVERRUN`。

Flash 侧识别 `WREN`、`RDSR`、`READ` 和 `WRITE` 命令，维护 WEL 状态、地址和 256 字节存储区。读写不是一次寄存器访问即可完成，而是由“命令、地址、数据”多个字节逐步推动状态机。该实现挂载在 G233 SoC 的 `0x10019000`，对应测试覆盖复位值、普通传输和 Flash 状态寄存器及读写流程。

这部分当前通过 QEMU 的 C/QOM 接口实现，而 I2C 总线和 GPIO-I2C 控制器使用 Rust 实现。两种实现放在同一个方向中对照，也让我更清楚 Rust 绑定并没有改变 QEMU 设备模型本身：无论使用哪种语言，都必须正确处理对象生命周期、MMIO 语义、总线拓扑和状态迁移。

## 总结

完成 GPGPU 和 Rust 两个方向后，我对 QEMU 的认识从“运行不同架构程序的模拟器”扩展到了“用软件描述硬件并验证其行为的框架”。GPGPU 方向训练了 PCIe、DMA、中断和指令解释执行；Rust 方向则训练了总线抽象、协议状态机，以及 Rust 与现有 C 工程之间的边界设计。

整个过程中最有效的方法是从测试和硬件手册共同反推设备语义。测试给出可观察行为，手册解释寄存器和协议为什么如此设计；只看其中一边，很容易得到只能通过单个测例、却无法保持完整状态一致性的实现。实现时再把大问题拆成“寄存器读写、状态迁移、数据路径、中断反馈”几层，调试会清晰很多。

对后续学员，我有三点建议：先逐个阅读测例，画出每次寄存器访问后的预期状态；把错误、复位和越界路径与正常路径同等对待；最后再运行整组测试，确认不同测例之间没有残留状态。对于 Rust 建模，还应尽量缩小 FFI 和 `unsafe` 的范围，把协议状态保留在可由类型系统约束的 Rust 代码中。
