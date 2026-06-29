# QEMU 训练营 2026 专业阶段总结

!!! note "主要贡献者"

    - 作者：[@flamboyante](https://github.com/flamboyante)

---

## 背景介绍

我是一名嵌入式软件工程师，目前从事卫星互联网相关方向的工作。以前接触 QEMU，基本都是站在使用者角度：用它启动镜像、搭验证环境、辅助调试，或者把它当成一块比较方便的虚拟开发板。那时候我关心的是“怎么把系统跑起来”，很少继续往下追：这块虚拟板子本身是怎么被 QEMU 建出来的。

参加训练营之后，我开始从实现者视角重新看 QEMU。一个虚拟平台背后有 machine、CPU、地址空间、中断控制器、MMIO 外设、设备树和测试框架。专业阶段我选择 G233 SoC 方向，也是因为这些内容和嵌入式软件日常接触的概念很接近：寄存器、中断、时钟、外设状态机，以及板级资源如何组织起来。

---

## 专业阶段

这次专业阶段，我主要完成的是 G233 SoC 的板级模型和几类 MMIO 外设建模。它不像基础题那样只补一个函数，而是要把一块 RISC-V 虚拟板子的基本框架和自定义外设接起来，再用 qtest 去验证寄存器读写、中断和虚拟时间行为。

### G233 board 的接入

G233 的最外层是 machine。它描述的是“这块虚拟板子长什么样”：DRAM 从哪里开始，UART、virtio、PLIC/ACLINT 放在哪里，自定义外设占用哪些 MMIO 地址，以及这些外设的 IRQ 分别接到哪根 PLIC source。

G233 需要先把地址空间布局定下来。对 SoC 建模来说，这一步很关键，因为后面 guest 看到的就是这些物理地址。按 datasheet 的描述，几个主要 MMIO 设备窗口大致如下：

| 设备 | 基地址 | 窗口大小 |
| --- | --- | --- |
| PL011 UART | `0x1000_0000` | 4 KiB |
| WDT | `0x1001_0000` | 4 KiB |
| GPIO | `0x1001_2000` | 256 B |
| PWM | `0x1001_5000` | 4 KiB |
| SPI | `0x1001_8000` | 4 KiB |

这里写出来的不是为了复刻完整地址表，而是强调一点：board 侧要先把 CPU 看到的物理地址窗口固定下来，后面的 MMIO 访问才有落点。

外设接入 board 的流程比较固定。以 G233 自定义外设为例，board 侧负责创建设备、realize、映射 MMIO，并把设备 IRQ 输出接到 PLIC：

```c
dev = qdev_new(TYPE_G233_GPIO);
s = SYS_BUS_DEVICE(dev);
sysbus_realize_and_unref(s, &error_fatal);
sysbus_mmio_map(s, 0, addr);
sysbus_connect_irq(s, 0, irq);
```

最终在 machine 初始化阶段，GPIO/PWM/WDT/SPI 分别映射到对应 MMIO 地址，并连接到 PLIC 的不同 IRQ source：

```text
GPIO -> PLIC IRQ 2
PWM  -> PLIC IRQ 3
WDT  -> PLIC IRQ 4
SPI  -> PLIC IRQ 5
```

写这部分时我一开始也容易把 board 和外设逻辑混在一起。后来才慢慢分清：`g233.c` 更像是在画这块板子的连线图，决定哪些设备放在哪段地址、IRQ 接到 PLIC 的哪一路；真正的寄存器行为，还是应该回到各个 `g233_xxx.c` 里处理。

### GPIO：寄存器与中断语义

GPIO 是我最先拿来梳理 MMIO 外设模型的部分。它的 state 中保存了方向、输出、输入、中断使能、中断状态、触发方式和极性：

```text
dir / out / in / ie / is / trig / pol
```

guest 通过 MMIO 写 `GPIO_DIR` 和 `GPIO_OUT` 后，QEMU 需要重新计算当前 pin 电平；写 `GPIO_IE/TRIG/POL` 后，需要重新评估中断条件；写 `GPIO_IS` 则是典型的 W1C 行为，用于清除中断状态。

这里有一个容易写错的点：edge interrupt 和 level interrupt 不能简单混在一个状态里。edge 状态是 sticky 的，检测到边沿后保持到 guest 清除；level 状态则应该根据当前电平实时重算。所以实现里拆成了 `edge_is` 和 `level_is` 两部分，最后再汇总到 `is`，并通过 `qemu_set_irq()` 驱动 PLIC：

```c
s->is = s->edge_is | s->level_is;
qemu_set_irq(s->irq, (s->is & s->ie) != 0);
```

这部分比单纯寄存器回显更接近真实外设：状态如何保持、如何清除、什么时候拉高中断线，都要在模型里表达出来。

### PWM：多通道状态与虚拟时间

PWM 的重点是多通道和虚拟时间。G233 PWM 控制器内部有 4 个 channel，每个 channel 都保存自己的控制寄存器、周期、占空比、计数值、完成标志和 `QEMUTimer`：

```c
typedef struct G233PWMChannel {
    uint32_t ctrl;
    uint32_t period;
    uint32_t duty;
    uint32_t cnt;
    bool done;
    QEMUTimer timer;
    int64_t last_update_ns;
} G233PWMChannel;
```

这里我用的是 `QEMUTimer`。PWM 更像“到某个虚拟时间点触发一次事件”：guest 使能某个 channel 时，模型记录当前虚拟时间，清零计数器，并根据 `period` 算出下一次完成事件的时间。读取 `COUNT` 时，不返回一个固定字段，而是根据 `QEMU_CLOCK_VIRTUAL` 推算已经过去的 tick：

```text
elapsed_ticks = (now - last_update_ns) * PWM_FREQ / NANOSECONDS_PER_SECOND
```

这样处理后，PWM 的行为就和虚拟时间绑定起来了。qtest 中通过 `qtest_clock_step()` 推进时间，就能验证 counter 和 done flag 是否按预期变化。这个思路和嵌入式里看定时器计数有点像，只不过这里的“时间”是 QEMU 的 virtual clock。

### WDT：ptimer、喂狗与超时中断

WDT 这部分主要练的是 QEMU 里的 `ptimer`。WDT 有 `CTRL/LOAD/VAL/SR/KEY` 这些寄存器：`CTRL` 控制使能、中断/复位使能和锁定状态，`LOAD` 设置计数初值，`VAL` 返回当前计数，`SR` 保存 timeout 状态，`KEY` 用于喂狗或锁定。

和 PWM 不同，WDT 更像一个持续递减的硬件计数器，所以这里用 `ptimer` 表达倒计时会更顺手。启动或喂狗时，模型会 stop timer、重新设置 count，如果 enable 位打开则重新运行：

```c
ptimer_stop(s->timer);
ptimer_set_count(s->timer, s->load);
if (s->ctrl & G233_WDT_CTRL_EN) {
    ptimer_run(s->timer, 1);
}
```

当 ptimer 超时，回调里置位 `G233_WDT_SR_TIMEOUT`，再根据 `CTRL_INTEN` 决定是否拉高中断线。这个外设代码量不大，但把“配置寄存器 -> 虚拟时间 -> 状态位 -> IRQ”这条链路走完整了。

### SPI 与 Flash：事务状态机

SPI 是这几个外设里状态机特征最明显的部分。控制器本身有 CR1、CR2、SR、DR 等寄存器，Flash 侧又有 JEDEC ID、status、当前命令、地址、phase、program/erase 标记和 busy timer。

Flash 访问不是一次 MMIO 就能完成的，而是一个由 CS 和连续字节传输组成的事务。例如：

```text
READ_DATA: 0x03 -> addr[23:16] -> addr[15:8] -> addr[7:0] -> data...
PAGE_PROGRAM: 0x02 -> address -> program data...
SECTOR_ERASE: 0x20 -> address -> busy -> done
JEDEC_ID: 0x9f -> manufacturer/type/capacity
```

所以 SPI flash 内部需要显式维护 phase：

```text
IDLE / JEDEC / STATUS / ADDR / READ_DATA / PROGRAM / ERASE
```

这样每次 guest 写 DR 时，模型才能知道当前字节到底是命令、地址还是数据。读 DR 时，也能根据 phase 返回 JEDEC ID、status 或 flash storage 中的数据。复杂外设难的往往不是寄存器数量，而是事务边界和状态迁移。

### State 和 Device 分层的理解

完成这些外设后，再回头看 QEMU 的 state/device 分层就比较清楚了：

- `RISCVG233State` 是整块 board 的状态，关心资源拓扑；
- `G233GPIOState/G233PWMState/G233WDTState/G233SPIState` 是挂在 SysBus 上的设备状态，关心 MMIO 和 IRQ；
- `G233PWMChannel`、`G233SPIFlash` 这类 sub-state 则表达设备内部更细的运行状态。

所以，QEMU 设备模型不能停留在寄存器读写回调这一层。它需要在不同层级维护硬件状态，再通过地址空间、中断线和虚拟时间把这些状态连接起来。

### 测试与调试

专业阶段里 qtest 对我帮助很大。平时做嵌入式软件，验证一个外设问题经常要准备固件、烧录、接串口、看日志，必要时还要上示波器或逻辑分析仪。这个流程很真实，但反馈链路比较长。qtest 的感觉更像是在主机侧直接拿一根“软件探针”去戳 MMIO 寄存器，不需要先把完整固件跑起来。

例如 GPIO 测试会检查 reset value、方向配置、输出回读和中断状态；PWM 测试会配置 period/duty、推进虚拟时钟并检查 counter/done flag；WDT 测试会验证 timeout；SPI/Flash 测试会覆盖 JEDEC ID、数据传输、擦除和写入。每个测试点都比较小，失败时通常能直接定位到某个寄存器语义或者某个状态迁移。

这也改变了我对调试顺序的理解。以前更习惯从驱动或者业务现象往下查；在 QEMU 里，如果外设模型本身还没稳定，先用 qtest 把 reset value、W1C、IRQ、timer、状态机这些基础行为打牢，后面再接固件或驱动会省很多时间。SoC 建模不能只追求“某个测试用例刚好通过”：GPIO 中断要区分 edge 和 level；SPI flash 要按命令、地址、数据阶段维护事务；PWM 计数要依赖虚拟时钟；WDT 要把 timeout 和 IRQ 连接起来。这些细节决定了模型后续能不能继续扩展。

---

## 总结

完成 G233 SoC 专业阶段后，我对 QEMU 里的 state 和 device 分层有了更具体的认识。

以前看 QEMU，容易只看到“某个设备有 read/write 回调”；现在再看，会先问几个更具体的问题：这个状态属于 board，还是属于 device？是整个控制器状态，还是某个 channel/flash transaction 的子状态？guest 写寄存器后，只改寄存器值够不够，还是还要更新 IRQ、timer 或事务阶段？

从工程角度看，这个实验也给我留下了几个比较实用的判断：

- board 负责拓扑，device 负责行为，不要把外设细节塞进 machine；
- MMIO 回调要表达寄存器语义，不能为了测试硬凑返回值；
- 中断和时间是外设模型的一部分，设计 state 时就要考虑进去；
- qtest 是验证 SoC 外设的高效入口，能尽早暴露状态机设计问题。

后续如果进入项目阶段，我希望继续沿着这个方向往下做：一方面把 G233 的设备模型补得更完整，另一方面也尝试从 guest 驱动或操作系统启动的角度，反推 QEMU 板级模型需要满足哪些约束。对我来说，这次训练营最大的价值不是“补完几个文件”，而是换了一个角度去理解虚拟硬件模型。
