# QEMU 训练营 2026 项目阶段：STM32F103 TIM2 定时器建模

!!! note "主要贡献者"

    - 作者：[@vsvnakers](https://github.com/vsvnakers)

---

本文总结 STM32F103 通用定时器 TIM2 的 QEMU 建模实现。代码基于 QEMU `stm32f103` machine，目标是让运行在板子上的裸机程序能够使用 TIM2 产生更新事件与输出比较中断。当前版本已实现 16 位向上计数、预分频、自动重装载、更新事件、输出比较与中断，配套 9 项 QTest 全部通过，并向上游提交了 [PR #16](https://github.com/shandianchengzi/qemu/pull/16)。

## 1. 项目介绍

STM32F103 是 ST 基于 Cortex-M3 内核的经典 MCU，广泛应用于嵌入式教学与工业控制。它包含多个定时器，其中 TIM2～TIM5 为 16 位通用定时器，具备：

- 16 位向上 / 向下 / 中央对齐计数
- 16 位可编程预分频器（PSC）
- 16 位自动重装载寄存器（ARR）
- 4 个独立通道，可用于输入捕获、输出比较、PWM 生成与单脉冲输出
- 更新事件、触发事件与各类中断

在本工作开始前，QEMU 上游 `stm32f103` machine 里 TIM2 仍由 `create_unimplemented_device()` 占位，guest 对其寄存器的任何访问都只会命中一个空的未实现区域，无法产生任何计数或中断行为。

本项目依据 STM32F10x 参考手册（RM0008）第 15 章「通用定时器」，为 QEMU 新增 STM32F1xx 通用定时器模型，并把 TIM2 接入现有 `stm32f103` machine，替换掉原来的占位符。范围上聚焦裸机固件最常依赖的向上计数、更新事件与输出比较功能，输入捕获、PWM 输出、从模式、DMA 与 RCC 时钟门控暂不建模。

## 2. 总体架构

### 2.1 计数模型

定时器输入时钟经过预分频器后驱动 16 位计数器，核心关系为：

```text
f_ck_cnt = f_ck_psc / (PSC + 1)
计数周期 = ARR + 1
```

计数器从 0 累加到 ARR 后回到 0，同时产生更新事件（Update Event）。模型用两个影子寄存器对 `active_psc` / `active_arr` 描述「当前生效」的分频与重装载值，源寄存器 `tim_psc` / `tim_arr` 的写入按预装载机制在更新事件时才真正生效，从而复现真实硬件的「PSC / ARR 缓冲」行为。

### 2.2 惰性求值

QEMU 中若为每个输入时钟边沿都递增计数器，代价过高。本模型采用惰性求值：不逐拍更新 `CNT`，而是记录一个基准状态 `(base_cnt, base_ns)`，读计数器时再根据流逝时间反推当前值：

```c
static uint64_t stm32f1xx_timer_get_count(STM32F1XXTimerState *s, int64_t now)
{
    uint64_t period = s->active_arr + 1ULL;
    uint64_t elapsed = 0;

    if (s->tim_cr1 & TIM_CR1_CEN) {
        elapsed = stm32f1xx_timer_ns_to_ticks(s, now - s->base_ns);
    }

    return (s->base_cnt + elapsed) % period;
}
```

`ns_to_ticks` 与 `ticks_to_ns` 分别用 `muldiv64` / `muldiv64_round_up` 在纳秒与输入时钟节拍之间换算：

```c
static uint64_t stm32f1xx_timer_ns_to_ticks(STM32F1XXTimerState *s, int64_t ns)
{
    uint64_t input_ticks;

    if (ns <= 0) {
        return 0;
    }

    input_ticks = muldiv64(ns, s->freq_hz, NANOSECONDS_PER_SECOND);
    return input_ticks / (s->active_psc + 1);
}
```

设备内部用 `QEMUTimer` 只安排「下一次事件」的到期时间，到期后统一处理标志位与中断，再安排下一次。这样事件驱动的开销与计数器频率无关，而只与事件数量相关。

### 2.3 事件调度

`stm32f1xx_timer_set_alarm` 计算当前计数到下一事件的剩余节拍，取「更新事件」与各通道「比较匹配」中最近者作为 alarm 目标：

```c
static void stm32f1xx_timer_set_alarm(STM32F1XXTimerState *s, int64_t now)
{
    ...
    period = s->active_arr + 1ULL;
    elapsed = stm32f1xx_timer_ns_to_ticks(s, now - s->base_ns);
    count = (s->base_cnt + elapsed) % period;
    ticks = period - count;
    s->next_event = TIM_SR_UIF;

    for (channel = 0; channel < ARRAY_SIZE(s->tim_ccr); channel++) {
        stm32f1xx_timer_find_compare(s, channel, period, count, &ticks,
                                     &s->next_event);
    }

    deadline = s->base_ns +
               stm32f1xx_timer_ticks_to_ns(s, elapsed + ticks);
    timer_mod(s->timer, MAX(deadline, now + 1));
}
```

到期回调 `stm32f1xx_timer_expire` 先锁定当前计数，按 `next_event` 置对应状态位，处理更新事件（含预装载转移与单脉冲停止），再刷新中断输出并安排下一次事件。

## 3. 实现概况

### 3.1 寄存器模型

模型实现 TIM2～TIM5 共用的寄存器布局，MMIO 窗口为 1 KiB：

| 偏移 | 寄存器 | 说明 |
| --- | --- | --- |
| `0x00` | `CR1` | 控制寄存器（CEN、UDIS、URS、OPM、ARPE） |
| `0x04` | `CR2` | 控制寄存器 2（当前仅存值，无副作用） |
| `0x08` | `SMCR` | 从模式控制（当前仅存值） |
| `0x0c` | `DIER` | DMA / 中断使能（UIE、CC1IE～CC4IE） |
| `0x10` | `SR` | 状态寄存器（UIF、CC1IF～CC4IF，rc_w0） |
| `0x14` | `EGR` | 事件生成（UG、CC1G～CC4G，只写） |
| `0x18` / `0x1c` | `CCMR1` / `CCMR2` | 捕获 / 比较模式 |
| `0x20` | `CCER` | 捕获 / 比较使能 |
| `0x24` | `CNT` | 计数器（读时惰性求值） |
| `0x28` | `PSC` | 预分频器 |
| `0x2c` | `ARR` | 自动重装载 |
| `0x34`～`0x40` | `CCR1`～`CCR4` | 捕获 / 比较值 |
| `0x48` / `0x4c` | `DCR` / `DMAR` | DMA 控制 / 连续模式地址（当前仅存值） |

`CR1` 只接受模型支持的位，屏蔽 `SUPPORTED_MASK` 之外写入：

```c
#define TIM_CR1_SUPPORTED_MASK (TIM_CR1_CEN | TIM_CR1_UDIS | TIM_CR1_URS | \
                                TIM_CR1_OPM | TIM_CR1_ARPE)
```

复位值对齐手册：`ARR` 复位为 `0xffff`，其余寄存器为 0。

### 3.2 更新事件与预装载

更新事件由计数溢出（`CNT` 从 ARR 回到 0）或软件写 `EGR.UG` 触发。处理逻辑集中在一个函数：

```c
static void stm32f1xx_timer_update_event(STM32F1XXTimerState *s,
                                         bool set_uif)
{
    if (s->tim_cr1 & TIM_CR1_UDIS) {
        return;
    }

    s->active_psc = s->tim_psc;
    s->active_arr = s->tim_arr;
    if (set_uif) {
        s->tim_sr |= TIM_SR_UIF;
    }
    if (s->tim_cr1 & TIM_CR1_OPM) {
        s->tim_cr1 &= ~TIM_CR1_CEN;
    }
}
```

几个关键位在此体现：

- `UDIS`：屏蔽更新事件，既不置 `UIF`，也不转移预装载值。
- `OPM`（单脉冲模式）：产生一次更新事件后自动清除 `CEN`，计数器停止。
- `URS`：仅抑制 `UG` 软件事件产生的 `UIF`，计数溢出产生的 `UIF` 不受影响。
- `ARPE`：写 `ARR` 时若置位，则新值等到下一次更新事件才加载到 `active_arr`；否则立即生效。`PSC` 则始终走预装载。

### 3.3 中断路径

状态位只有同时被 `DIER` 使能才会反映到中断线上。模型用一条电平中断输出，`qemu_set_irq` 的取值由「状态 & 使能」直接决定：

```c
static void stm32f1xx_timer_update_irq(STM32F1XXTimerState *s)
{
    qemu_set_irq(s->irq, (s->tim_sr & s->tim_dier & TIM_SR_IRQ_MASK) != 0);
}
```

`SR` 为 rc_w0：guest 写 0 清除对应位，`update_irq` 随后重算中断线，因此清除 `UIF` 同时会撤销中断输出。这条 IRQ 在 machine 层接到 Cortex-M3 NVIC 的 IRQ 28。

### 3.4 输出比较

通道配置为输出模式（`CCMR` 中 `CCxS == 0`）且 `CCRx <= ARR` 时，计数器匹配 `CCRx` 会置对应 `CCxIF`。比较匹配按「下一次匹配」的剩余节拍纳入 alarm 调度：

```c
static void stm32f1xx_timer_find_compare(STM32F1XXTimerState *s,
                                         unsigned int channel,
                                         uint64_t period, uint64_t count,
                                         uint64_t *best_delta,
                                         uint32_t *next_event)
{
    uint64_t delta;
    uint32_t flag = TIM_SR_CC1IF << channel;

    if (!stm32f1xx_timer_channel_is_output(s, channel) ||
        s->tim_ccr[channel] > s->active_arr) {
        return;
    }

    delta = (s->tim_ccr[channel] + period - count) % period;
    if (delta == 0) {
        delta = period;
    }

    if (delta < *best_delta) {
        *best_delta = delta;
        *next_event = flag;
    } else if (delta == *best_delta) {
        *next_event |= flag;
    }
}
```

`CCxIF` 的置位与 `CCxIE` 使能解耦：即使不使能比较中断，标志位也会照常置位，符合手册语义。

### 3.5 迁移与 VMState

定时器含「基于当前时间的惰性计数」这一非常量状态，因此迁移前后需要特殊处理。`pre_save` 先把当前计数固化到 `base_cnt`，`post_load` 再以载入时间为新基准重算中断与 alarm：

```c
static int stm32f1xx_timer_pre_save(void *opaque)
{
    STM32F1XXTimerState *s = opaque;

    stm32f1xx_timer_latch_count(
        s, qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL));
    return 0;
}

static int stm32f1xx_timer_post_load(void *opaque, int version_id)
{
    STM32F1XXTimerState *s = opaque;
    int64_t now = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);

    s->base_ns = now;
    stm32f1xx_timer_update_irq(s);
    stm32f1xx_timer_set_alarm(s, now);
    return 0;
}
```

设备状态结构如下：

```c
struct STM32F1XXTimerState {
    SysBusDevice parent_obj;

    MemoryRegion iomem;
    QEMUTimer *timer;
    qemu_irq irq;

    uint64_t freq_hz;

    int64_t base_ns;
    uint64_t base_cnt;
    uint32_t next_event;

    uint32_t tim_cr1;
    uint32_t tim_cr2;
    uint32_t tim_smcr;
    uint32_t tim_dier;
    uint32_t tim_sr;
    uint32_t tim_ccmr1;
    uint32_t tim_ccmr2;
    uint32_t tim_ccer;
    uint32_t tim_psc;
    uint32_t active_psc;
    uint32_t tim_arr;
    uint32_t active_arr;
    uint32_t tim_ccr[4];
    uint32_t tim_dcr;
    uint32_t tim_dmar;
};
```

`freq_hz` 通过 `clock-frequency` 属性注入，默认 72 MHz；在 RCC 时钟输出被建模之前，先以固定输入时钟近似。

## 4. 接入 STM32F103 machine

在 SoC 层新增一个 TIM2 实例，并替换原来的占位符：

```c
#define TIM2_ADDR          0x40000000
#define TIM2_IRQ           28
#define TIM2_CLOCK_FREQ_HZ 72000000
```

`stm32f103_soc_initfn` 中用 `object_initialize_child` 创建子设备：

```c
object_initialize_child(obj, "tim2", &s->timer, TYPE_STM32F1XX_TIMER);
```

`stm32f103_soc_realize` 中设置时钟频率、realize 设备、映射 MMIO 并连接 IRQ：

```c
/* TIM2 general-purpose timer */
dev = DEVICE(&s->timer);
qdev_prop_set_uint64(dev, "clock-frequency", TIM2_CLOCK_FREQ_HZ);
if (!sysbus_realize(SYS_BUS_DEVICE(dev), errp)) {
    return;
}
busdev = SYS_BUS_DEVICE(dev);
sysbus_mmio_map(busdev, 0, TIM2_ADDR);
sysbus_connect_irq(busdev, 0, qdev_get_gpio_in(armv7m, TIM2_IRQ));
```

同时删除 APB1 外设列表中的占位行：

```c
-    create_unimplemented_device("timer[2]",    0x40000000, 0x400);
```

其余改动为配套的 Kconfig（`STM32F1XX_TIMER`）、meson 构建、`MAINTAINERS` 与头文件包含。

## 5. qtest 设计

新增 `stm32f103-timer-test`，挂在 `-machine stm32f103` 上，通过 `qtest_irq_intercept_in` 拦截 NVIC 中断输入，共 9 个测试：

| 测试 | 验证内容 |
| --- | --- |
| `reset` | 各寄存器复位值（CR1/DIER/SR/EGR/CNT/PSC=0，ARR=0xffff） |
| `update-irq` | 更新事件时序、电平中断输出、写 0 清 `UIF` 并撤销中断 |
| `enable-disable` | 清除 `CEN` 后计数器暂停 |
| `output-compare` | `CC2IF` 置位与 `CC2IE` 使能解耦，下一周期再次匹配 |
| `prescaler-preload` | `PSC` 写入在下一个更新事件生效 |
| `update-disable` | `UDIS` 屏蔽更新事件与预装载转移 |
| `update-request-source` | `URS` 抑制 `UG` 的 `UIF` 但不抑制溢出 `UIF` |
| `one-pulse` | `OPM` 单脉冲模式在更新事件后自动停止 |
| `auto-reload-preload` | `ARPE` 下 `ARR` 在下一更新事件生效 |

测试用固定预分频 71，使 72 MHz 输入时钟除以 72 后得到 1 MHz，即每个节拍恰为 1 μs，便于用纳秒直接换算期望计数。例如 `update-irq` 以周期 1000 个节拍（1 ms）推进虚拟时钟，验证溢出边界前后 `UIF` 与中断线的翻转：

```c
clock_step(period_ns - 1);
g_assert_cmphex(tim2_readl(TIM_SR) & TIM_SR_UIF, ==, 0);
g_assert_false(get_irq(TIM2_IRQ));

clock_step(1);
g_assert_cmphex(tim2_readl(TIM_SR) & TIM_SR_UIF, ==, TIM_SR_UIF);
g_assert_true(get_irq(TIM2_IRQ));

/* SR is rc_w0: clearing UIF must also deassert the interrupt output. */
tim2_writel(TIM_SR, 0);
g_assert_cmphex(tim2_readl(TIM_SR) & TIM_SR_UIF, ==, 0);
g_assert_false(get_irq(TIM2_IRQ));
```

运行命令：

```bash
cd qemu
ninja -C build qemu-system-arm

build/pyvenv/bin/meson test -C build \
    qemu:qtest-arm/stm32f103-timer-test --print-errorlogs
```

当前结果：

```text
1/1 qemu:qtest-arm/stm32f103-timer-test OK
9 subtests passed
```

## 6. 裸机验证

除 qtest 外，还用裸机程序在 `stm32f103` machine 上实机验证：程序配置 TIM2 产生更新中断与 CC2 比较中断，成功触发两类中断，进一步确认了模型在真实固件场景下的可用性。

## 7. 上游协作

当前工作以单个 PR 形式提交，标题为：

```text
hw/timer: add STM32F103 TIM2 support
```

PR 描述明确了实现范围（16 位向上计数、预分频、自动重装载、更新事件、输出比较、中断）、NVIC IRQ 28 连接、配套 QTest，以及相关 Issue #13。这也是从训练营专业阶段实验走向真实上游设备建模的一次衔接。

## 8. 总结与心得

本工作为 QEMU `stm32f103` machine 提供了 TIM2 通用定时器支持，让原先的空占位符变成了具备计数、更新事件、输出比较与中断能力的真实设备，并配套 9 项 QTest 覆盖关键寄存器语义与边角行为。

过程中对定时器这一类「基于时间的设备」在 QEMU 里的建模范式有了更具体认识：惰性求值 + 事件驱动 alarm 避免了逐节拍模拟的开销，预装载影子寄存器复现了硬件的缓冲语义，迁移钩子则处理了时间相关状态在快照 / 恢复时的一致性问题。这些经验与专业阶段做 PCI 设备时是互补的，也让自己对 QEMU 设备模型的理解从「把寄存器存起来」推进到「把硬件行为语义做对」。

## 9. 后续方向

- 跟进 PR 审阅意见并推动合入上游
- 补齐输入捕获、PWM 输出、从模式与 DMA 请求等剩余功能
- 接入 RCC 时钟门控与可配置时钟源，替换当前的固定时钟近似
- 视需要将模型推广到 TIM3～TIM5 的实例化

## 参考资料

\[1] STMicroelectronics. RM0008: STM32F101xx, STM32F102xx, STM32F103xx, STM32F105xx and STM32F107xx advanced Arm-based 32-bit MCUs Reference Manual. <https://www.st.com/resource/en/reference_manual/rm0008-stm32f101xx-stm32f102xx-stm32f103xx-stm32f105xx-and-stm32f107xx-advanced-armbased-32bit-mcus-stmicroelectronics.pdf>

\[2] QEMU 上游 `stm32f103` machine。<https://github.com/qemu/qemu/blob/master/hw/arm/stm32f103_soc.c>

\[3] 本工作 PR。 <https://github.com/shandianchengzi/qemu/pull/16>

\[4] QEMU Camp 训练营。 <https://qemu.gevico.online/>
