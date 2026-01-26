# QEMU 时钟系统

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

QEMU 的“时钟系统”包含两套相关但不同的机制：一套是驱动定时器与主循环的 **QEMUClock/QEMUTimer**，另一套是建模硬件时钟树的 **Clock QOM 对象**。理解它们的职责边界，是写出稳定设备模型和掌握时间推进逻辑的关键。

一句话总结：**QEMUClock 决定“时间怎么走”，Clock 决定“频率怎么分发”。**

!!! tip "概览"

    - QEMUClock 提供虚拟/宿主/实时等多种时间基准
    - QEMUTimer 绑定到某个时钟类型，驱动设备定时事件
    - 主循环用“最近到期时间”决定 poll 超时
    - Clock 对象用于建模硬件时钟树与频率传播

## 相关概念

在 QEMU 中常见的“时钟”其实是两层概念：

1. **QEMUClock（软件时钟）**：用于调度定时器、控制虚拟时间推进，核心接口在 `include/qemu/timer.h`。
2. **Clock（硬件时钟）**：QOM 对象，用于设备/SoC 建模时钟输入输出与频率树，核心接口在 `include/hw/core/clock.h`。

官方文档也明确提出“时钟树建模”的概念（见 QEMU 文档 devel/clocks）。在这里可以把它理解为：**前者控制“时间尺度”，后者描述“频率拓扑”。**

## 时钟类型

QEMU 提供多种时钟类型，常见定义如下：

```c
/* include/qemu/timer.h */
typedef enum {
    QEMU_CLOCK_REALTIME = 0,
    QEMU_CLOCK_VIRTUAL = 1,
    QEMU_CLOCK_HOST = 2,
    QEMU_CLOCK_VIRTUAL_RT = 3,
    QEMU_CLOCK_MAX
} QEMUClockType;
```

含义要点：

- `QEMU_CLOCK_VIRTUAL`：只在 VM 运行时前进，停止 VM 就停止。
- `QEMU_CLOCK_REALTIME`：与宿主真实时间一致，通常不应影响 VM 状态。
- `QEMU_CLOCK_HOST`：反映宿主系统时间变化（如 NTP 校时）。
- `QEMU_CLOCK_VIRTUAL_RT`：icount 模式下用于“补足”虚拟时间。

时钟类型最终映射到具体时间源，例如：

```c
/* util/qemu-timer.c */
int64_t qemu_clock_get_ns(QEMUClockType type)
{
    switch (type) {
    case QEMU_CLOCK_REALTIME:
        return get_clock();
    default:
    case QEMU_CLOCK_VIRTUAL:
        return cpus_get_virtual_clock();
    case QEMU_CLOCK_HOST:
        return REPLAY_CLOCK(REPLAY_CLOCK_HOST, get_clock_realtime());
    case QEMU_CLOCK_VIRTUAL_RT:
        return REPLAY_CLOCK(REPLAY_CLOCK_VIRTUAL_RT, cpu_get_clock());
    }
}
```

## 定时器

QEMUTimer 是“时间驱动器”：设备用它安排“未来某个时间点”的事件。
常见 API 是 `timer_init_*`、`timer_mod_*`、`timer_del`：

```c
/* include/qemu/timer.h */
void timer_init_ns(QEMUTimer *ts, QEMUClockType type,
                   QEMUTimerCB *cb, void *opaque);
void timer_mod_ns(QEMUTimer *ts, int64_t expire_time);
void timer_del(QEMUTimer *ts);
```

经验规则：

- 设备行为与“客户机时间”绑定时，优先用 `QEMU_CLOCK_VIRTUAL`。
- 纯宿主侧辅助逻辑（统计/日志）才考虑 `QEMU_CLOCK_REALTIME`。

## 主循环

主循环会结合所有时钟的“最近到期时间”计算 poll 超时，并在返回后执行到期定时器：

```c
/* util/main-loop.c */
void main_loop_wait(int nonblocking)
{
    int64_t timeout_ns;

    timeout_ns = qemu_soonest_timeout(timeout_ns,
                                      timerlistgroup_deadline_ns(
                                          &main_loop_tlg));

    ret = os_host_main_loop_wait(timeout_ns);
    qemu_clock_run_all_timers();
}
```

因此，**定时器越精确，主循环唤醒就越及时**。如果你发现设备“超时不准”，通常要先确认它是否挂在了正确的时钟类型上。

## 设备钟

Clock 用于建模硬件时钟树。设备在 realize 之前创建输入/输出时钟端口：

```c
/* hw/core/qdev-clock.c */
Clock *qdev_init_clock_in(DeviceState *dev, const char *name,
                          ClockCallback *callback, void *opaque,
                          unsigned int events);
Clock *qdev_init_clock_out(DeviceState *dev, const char *name);
void qdev_connect_clock_in(DeviceState *dev, const char *name, Clock *source);
```

频率更新通过 `clock_update_hz/clock_update_ns` 传播到子时钟：

```c
/* include/hw/core/clock.h */
static inline void clock_update_hz(Clock *clk, unsigned hz)
{
    clock_update(clk, CLOCK_PERIOD_FROM_HZ(hz));
}
```

这套机制解决了“板级/SoC 时钟树”建模问题：PLL、分频器、门控等变化可以沿树传播，并触发设备内部回调。

## 状态迁移

与时钟相关的状态通常需要迁移：Clock 对象提供 `vmstate_clock`，设备可以用 `VMSTATE_CLOCK` 写入迁移描述。

另一方面，在 icount 模式下，`QEMU_CLOCK_VIRTUAL_RT` 用于在 vCPU 休眠期间推进虚拟时间，避免时间停滞。核心逻辑是“推进虚拟时钟并触发到期定时器”：

```c
/* util/qemu-timer.c */
int64_t qemu_clock_advance_virtual_time(int64_t dest)
{
    int64_t clock = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
    while (clock < dest) {
        int64_t deadline = qemu_clock_deadline_ns_all(QEMU_CLOCK_VIRTUAL,
                                                      QEMU_TIMER_ATTR_ALL);
        int64_t warp = qemu_soonest_timeout(dest - clock, deadline);
        qemu_virtual_clock_set_ns(qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) + warp);
        qemu_clock_run_timers(QEMU_CLOCK_VIRTUAL);
        clock = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
    }
    qemu_clock_notify(QEMU_CLOCK_VIRTUAL);
    return clock;
}
```

## 本章小结

QEMU 的时钟系统分为“时间基准 + 定时器”和“硬件时钟树”两套机制。前者解决“事件何时发生”，后者解决“频率如何分发”。掌握这两条脉络，就能更自信地阅读主循环、设备定时器以及板级时钟树相关代码。
