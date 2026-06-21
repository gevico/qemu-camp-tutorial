# QEMU 训练营 2026 专业阶段总结

!!! note "主要贡献者"

    - 作者：[@Sunuywq](https://github.com/Sunuywq)

---

## 背景介绍

这里是一名即将研二的学生。去年 9 月在 B 站大学学习 QEMU 时，看到有开源社区的学习机会，抱着学习的心态参加了 **2025 年 QEMU 训练营**。因中途加入，只完成了基础部分与专业阶段。

今年参加 **2026 QEMU 训练营**，希望进入项目阶段实践：一方面继续巩固 QEMU 相关能力，另一方面也想接触 **vibe coding** 的技巧。

---

## 开发环境

| 项目 | 说明 |
|------|------|
| 主机 | Windows |
| 开发机 | WSL（Windows Subsystem for Linux） |
| AI 搭子 | Claude code |

---

## 专业阶段

今年的专业阶段提供了更丰富的方向，我最终决定将重心放在 **SoC 建模** 上。

相比去年的课程设计，今年在体验上有了显著优化：
* **SoC 建模门槛降低**：去年的建模任务对初学者挑战较大，需要从零搭建 G233 主板；而今年官方直接内置了基础的 board 环境，可以更聚焦于设备本身。
* **验证方式的升级**：去年的测试主要依赖 CPU 去执行类似裸机（bare metal）的代码；今年则全面引入了 **qtest** 框架，这使得我们对底层硬件地址和寄存器的读写访问变得更加纯粹和直观。

以下是我在本次 SoC 实验中的核心知识点复盘。

实现一个全新外设的硬件模拟，本质上是完成**三类代码文件的开发与集成**：
1. 编写全新的外设设备逻辑文件（Device Model）
2. 修改 G233 主板文件以挂载新设备（Machine/Board）
3. 更新编译系统的配置文件（Meson/Kconfig）

---

### 建模思路简述

设备建模的核心前提是吃透 QEMU 的 **QOM（QEMU 对象模型）** 机制（结合导学资料与 B 站课程）。尽管当下借助 AI 能快速生成模板代码，但**精准把控每一行代码的底层逻辑**依然是不可或缺的基本功。具体的模拟逻辑如下：依赖 **MMIO 内存读写回调** 捕获请求；严格依照芯片硬件手册（Datasheet）落实寄存器的读写副作用；硬件中断信号则是通过 **`qemu_irq`** 体系进行路由和传递。

**以 GPIO 控制器的建模为例**

在 **类初始化函数 `g233_gpio_class_init`** 中，我们需要对 `DeviceClass` 的关键回调进行绑定：
* `dc->realize` → 映射至 `g233_gpio_realize`（负责分配 MMIO 内存空间、初始化 IRQ 和 GPIO 引脚）
* `dc->vmsd` → 映射至 `vmstate_g233_gpio`（支持虚拟机的热迁移状态保存）
* `device_class_set_legacy_reset` → 映射至 `g233_gpio_reset`（定义硬件复位行为）
* `dc->desc` → 设备的具象化文本描述

> **QOM 视角解析**：该设备在 QOM 树中被定义为挂载于 SysBus（系统总线）上的 GPIO 设备类。`realize` 阶段是设备的“物质化”过程，将抽象的代码类转化为可以被分配内存、连接引脚的实体对象。

具体的代码实现细节包含：
1. **实例状态指针**：在 MMIO 读写和 GPIO 输入回调函数中，传入的 `opaque` 指针实际上代表着设备的独立状态域 **`G233GPIOState`**。我们通过该结构体集中管理寄存器的当前值、引脚方向（输入/输出）、中断使能掩码以及输出引脚电平状态。

2. **MMIO 读写回调**：设备通过在 `instance_init` 阶段调用 `memory_region_init_io()` 创建 MMIO 区域，并将 `MemoryRegionOps` 绑定到自定义的 `_read` / `_write` 函数。以 GPIO 为例：

    ```c
    static const MemoryRegionOps g233_gpio_ops = {
        .read = g233_gpio_read,
        .write = g233_gpio_write,
        .endianness = DEVICE_NATIVE_ENDIAN,
        .valid = { .min_access_size = 4, .max_access_size = 4 },
    };
    ```

    在 `_write` 回调中，依据偏移量（`addr`）区分操作的是方向寄存器、输出寄存器还是中断使能寄存器，再根据硬件手册的读写语义更新状态。`_read` 回调则返回对应寄存器的快照值。

3. **中断信号路由**：GPIO 控制器通过 `qemu_irq` 将中断事件上报给 PLIC。关键调用路径：

    * `sysbus_init_irq(sbd, &s->irq)` — 在 `instance_init` 中注册中断引脚
    * `qemu_set_irq(s->irq, level)` — 在 `_write` 回调中，当中断状态发生变化时拉高/拉低 IRQ 电平
    * PLIC 收到电平变化后设置 pending 位，等待 CPU 通过 claim/complete 流程响应

    > **IRQ 的实质**：`qemu_irq` 是一条可以传递电平信号的虚拟连线。设备端拉高 IRQ 等同于真实硬件中一根物理引脚的电平翻转——下游的 PLIC 正是通过感知这个翻转来感知外设请求。

    以 GPIO 为例，中断触发条件为：某引脚被配置为输入模式 → 且该引脚的中断使能位已打开 → 且引脚电平发生了变化。此时在写寄存器的 `_write` 回调末尾，评估所有引脚的中断状态，通过 OR 逻辑汇总后调用 `qemu_set_irq`。

---

### 其他外设建模要点

除了 GPIO，本次 SoC 实验还涉及 PWM、WDT 和 SPI 三类外设。虽然设备行为各不相同，但建模思路高度一致——**QOM 框架负责接入，硬件手册定义行为**。

#### PWM 控制器

PWM（脉冲宽度调制）的核心是周期性计数器：计数器从 0 递增到 PERIOD 后归零，比较计数器当前值与 DUTY 寄存器的值来决定输出电平高低。QEMU 中推荐使用 `ptimer` 来驱动这个周期性行为：

```c
s->ptimer = ptimer_init(g233_pwm_tick, s, PTIMER_POLICY_DEFAULT);
ptimer_set_period(s->ptimer, tick_ns);
ptimer_set_limit(s->ptimer, period, 1);
ptimer_run(s->ptimer, 0);  // 连续模式
```

定时器每次到期触发 `g233_pwm_tick` 回调，在其中递增计数、比较阈值、更新输出引脚电平，并检测 `DONE` 标志（当 CNT == DUTY 或 CNT 归零时置位）。多通道 PWM 可复用同一 `ptimer`，在回调中遍历所有通道。

#### WDT 看门狗定时器

WDT 的建模比 PWM 更简单：它本质上是一个倒计时的 `ptimer`。LOAD 寄存器写入时重置计数器，计数器递减到 0 时触发超时中断——如果 WDT 未被及时喂狗（重新写入 LOAD），则认为系统异常。

```c
ptimer_set_limit(s->ptimer, s->load, 1);
ptimer_run(s->ptimer, 1);  // 单次模式，超时触发中断
```

关键点：
* 写入 LOAD 寄存器 → 更新计数上限并重新启动定时器（"喂狗"）
* 计数器归零 → `qemu_set_irq` 上报超时中断
* CONTROL 寄存器的使能位控制定时器启停

#### SPI 控制器与 Flash

SPI 控制器的建模难点在于**协议状态机**——不同于 GPIO/PWM/WDT 的寄存器驱动模式，SPI 涉及多字节事务（命令→地址→数据→CS 拉低/拉高）。核心结构：

1. **寄存器层**：CR1（控制）/ SR（状态）/ DR（数据）/ CS（片选），MMIO 读写同 GPIO 模式
2. **总线层**：通过 `ssi_create_bus()` 创建 SSI 总线，`ssi_transfer()` 完成单字节传输
3. **从设备**：SPI Flash 实现 `transfer()` 回调，解析命令字节（WREN/RDSR/READ/WRITE）并更新内部状态机

SSI 总线的本质是主控向所有挂载的从设备广播一字节，仅 CS 激活的从设备响应。Flash 的内部状态机需要处理 WEL（写使能锁存）和 WIP（写进行中）两个关键标志位，以及 256 字节的模拟存储数组。

---

### 编译集成与板级接线

完成设备建模代码之后，还需要让 QEMU 认识这些新设备。涉及的修改项如下：

| 文件 | 修改内容 |
|------|----------|
| `hw/gevico/g233_gpio.c` | GPIO 控制器实现（~210 行） |
| `hw/gevico/g233_pwm.c` | PWM 控制器实现（~250 行） |
| `hw/gevico/g233_wdt.c` | WDT 控制器实现（~230 行） |
| `hw/gevico/g233_spi.c` | SPI 控制器实现（~210 行） |
| `hw/gevico/Kconfig` | 新增 `GEVICO_G233_PERIPH` 配置项 |
| `hw/gevico/meson.build` | 将外设源文件加入编译 |
| `hw/Kconfig` | `source gevico/Kconfig` |
| `hw/meson.build` | `subdir('gevico')` |
| `hw/riscv/Kconfig` | `GEVICO_G233` 增加 `select GEVICO_G233_PERIPH` |
| `include/hw/riscv/g233.h` | 添加各外设的内存映射基址和 IRQ 号定义 |
| `hw/riscv/g233.c` | 实例化各外设并完成 MMIO 映射与中断连线 |

板级接线（以 g233.c 为例）遵循统一模式：

```c
// 1. 创建 SysBus 设备
dev = qdev_new(TYPE_G233_GPIO);
// 2. 将设备挂载到系统总线
sysbus_realize_and_unref(SYS_BUS_DEVICE(dev), &error_fatal);
// 3. 映射 MMIO 物理地址
sysbus_mmio_map(SYS_BUS_DEVICE(dev), 0, VIRT_GPIO0);
// 4. 连接中断线到 PLIC
sysbus_connect_irq(SYS_BUS_DEVICE(dev), 0,
                   qdev_get_gpio_in(plic, GPIO_IRQ));
```

> **线索串联**：Kconfig 打开编译开关 → Meson 将 .c 文件编译进 qemu-system-riscv64 → g233.c 中的 `qdev_new` 触发 QOM 类型实例化 → `class_init` 绑定回调 → `realize` 分配 MMIO 和 IRQ → 虚拟机启动后 Guest 即可通过物理地址访问外设。

---

### QTest 验证

今年训练营全面采用 **qtest** 框架进行外设验证，这是一个轻量级的硬件测试框架：它启动一个最小化的 QEMU 实例（无 CPU 执行），通过直接读写 MMIO 地址来验证设备行为。

**2025 年 vs 2026 年测试方式对比**

| 对比维度 | 2025 年（裸机方式） | 2026 年（qtest 方式） |
|----------|---------------------|------------------------|
| 测试入口 | 编译测试程序为 ELF，CPU 执行 | `qtest_init("-machine g233")` |
| 寄存器访问 | 通过 CPU 指令（load/store） | `qtest_readl/writel(qts, addr)` |
| 中断验证 | 需要 ISR + 复杂软件栈 | `qtest_get_irq_level(qts, irq)` 直接读电平 |
| 时钟控制 | 依赖实际时间流逝 | `qtest_clock_step(ns)` 精确步进 |
| 反馈速度 | 秒级 | 毫秒级 |

举例：验证 GPIO 方向寄存器的复位值：

```c
static void test_gpio_reset(void)
{
    QTestState *qts = qtest_init("-machine g233 -m 2G");
    uint32_t val = qtest_readl(qts, 0x10012000 + GPIO_DIR);
    g_assert_cmpuint(val, ==, 0x00000000);  // 复位后全部为输入
    qtest_quit(qts);
}
```

本次我通过了 SoC 方向全部测试用例，包括 GPIO 基础读写与中断、PWM 周期与占空比、WDT 超时与喂狗、SPI Flash 读写与片选等，覆盖了从寄存器访问到中断链路的完整验证路径。

---

## 总结

回顾专业阶段的学习过程，最大的收获不在于写出了多少行外设代码，而在于**建立了一套设备建模的思维框架**：

1. **QOM 是骨架**：设备类型的注册、继承、实例化全由 QOM 统一管理，理解了 `TypeInfo → class_init → realize` 这条链就理解了设备在 QEMU 中如何诞生
2. **MMIO 是窗口**：Guest 通过内存读写来操控硬件——`memory_region_init_io` 注册的回调就是这扇窗的入口
3. **IRQ 是信使**：`qemu_irq` 体系让设备能够异步通知 CPU，PLIC 负责汇总和路由
4. **手册是答案**：所有寄存器的读写语义都来自硬件手册，AI 可以帮你写代码框架，但**判断代码是否正确的唯一标准是 Datasheet**

从去年的裸机测试到今年的 qtest 框架，从手写 G233 主板到内置 board 环境——训练营在降低入门门槛的同时，并没有削弱对底层原理的要求。这种平衡对于初学者非常友好。

后续进入项目阶段，我希望在 SoC 建模的基础上进一步探索 QEMU 的设备虚拟化链路，同时借助 AI 辅助（Claude Code）提升开发效率——但始终记住一点：**AI 可以帮你写代码，但你需要自己知道代码为什么是对的。**`