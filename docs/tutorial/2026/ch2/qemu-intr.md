# QEMU 中断与异常：TCG 执行循环里的处理流程

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

本文以 QEMU system mode + TCG 为背景，梳理“模拟 CPU 的中断/异常”处理链路。我们关注两个问题：中断/异常如何进入 CPU 执行循环？架构相关的处理逻辑在哪里落地？

一句话总结：**QEMU 会在 TB 边界检查中断和异常，并把真正的处理交给目标架构的回调**。

!!! tip "概览"

    - 中断/异常/退出请求的来源与状态表示
    - TB 边界的执行检查点与主循环路径
    - setjmp/longjmp 的异常返回机制
    - 设备到 vCPU 的中断注入与延迟处理
    - 架构相关处理钩子与 RISC-V 例子

## 中断、异常、退出请求

在 QEMU 里，vCPU 会因为这三类事件而回到 host 世界：

- **异常（exception）**：同步事件，通常由当前指令触发（非法指令、TLB miss、系统调用等）。以 `CPUState::exception_index` 表示。
- **中断（interrupt）**：异步事件，通常来自设备、定时器或外部控制。以 `CPUState::interrupt_request` 的比特位表示。
- **退出请求（exit）**：不是传统意义的中断/异常，更多用于让执行循环“停下来重新评估状态”。例如 `CPU_INTERRUPT_EXITTB`。

`CPU_INTERRUPT_*` 的定义集中在 `include/exec/cpu-interrupt.h`，其中硬件中断与“退出 TB”请求最常见：

```c
/* include/exec/cpu-interrupt.h */
#define CPU_INTERRUPT_HARD        0x0002
#define CPU_INTERRUPT_EXITTB      0x0004
#define CPU_INTERRUPT_HALT        0x0020
#define CPU_INTERRUPT_RESET       0x0400
```

理解这两类状态很重要：**异常用 `exception_index`，中断用 `interrupt_request`**，而它们最终都会在执行循环的固定检查点被处理。

## 主循环：双层 while 的“检查点”

TCG 执行循环在 `accel/tcg/cpu-exec.c`，核心是双层 `while`：外层处理异常，内层处理中断并执行 TB。

```c
/* accel/tcg/cpu-exec.c */
while (!cpu_handle_exception(cpu, &ret)) {
    TranslationBlock *last_tb = NULL;

    while (!cpu_handle_interrupt(cpu, &last_tb)) {
        TranslationBlock *tb;
        TCGTBCPUState s = cpu->cc->tcg_ops->get_tb_cpu_state(cpu);

        tb = tb_lookup(cpu, s);
        if (tb == NULL) {
            tb = tb_gen_code(cpu, s);
        }
        cpu_loop_exec_tb(cpu, tb, s.pc, &last_tb, &tb_exit);
    }
}
```

可以把它理解成：

- **外层 while**：如果 `exception_index` 已经被设置（同步异常），先处理异常再继续。
- **内层 while**：在执行 TB 之前/之后检查 `interrupt_request`，必要时把控制权交给中断处理逻辑。

这也解释了“中断通常在 TB 边界被处理”的现象：处于性能考虑，QEMU 会在循环检查点处理它，而不是在 TB 内部任意位置打断。

## 异常返回点：setjmp/longjmp

异常通常由 vCPU 自身在执行指令时触发（例如非法指令、访存异常或调试事件）。为了让 vCPU 及时回到“可控的主循环”，QEMU 在进入 `cpu_exec_loop()` 之前设置异常返回点，并在需要退出 TB 时用 `siglongjmp()` 直接跳回该位置。

设置返回点的逻辑在 `cpu_exec_setjmp()` 中：

```c
/* accel/tcg/cpu-exec.c */
static int cpu_exec_setjmp(CPUState *cpu, SyncClocks *sc)
{
    /* Prepare setjmp context for exception handling. */
    if (unlikely(sigsetjmp(cpu->jmp_env, 0) != 0)) {
        cpu_exec_longjmp_cleanup(cpu);
    }

    return cpu_exec_loop(cpu, sc);
}
```

而“跳回返回点”的入口是 `cpu_loop_exit()`，它会清理状态并直接 `siglongjmp()`：

```c
/* accel/tcg/cpu-exec-common.c */
void cpu_loop_exit(CPUState *cpu)
{
    /* Undo the setting in cpu_tb_exec.  */
    cpu->neg.can_do_io = true;
    /* Undo any setting in generated code.  */
    qemu_plugin_disable_mem_helpers(cpu);
    siglongjmp(cpu->jmp_env, 1);
}
```

因此，当 vCPU 触发异常或需要“强制退出 TB”时，相关路径会调用 `cpu_loop_exit()`，把控制权带回 `cpu_exec_loop()` 的安全检查点，再由 `exception_index` 和中断标志进行后续处理。

## 中断注入路径：从设备到 vCPU

中断进入 vCPU 的入口之一是 `tcg_handle_interrupt`。它会设置 `interrupt_request` 的位，并唤醒 vCPU：

```c
/* accel/tcg/tcg-accel-ops.c */
void tcg_handle_interrupt(CPUState *cpu, int mask)
{
    cpu_set_interrupt(cpu, mask);

    if (!qemu_cpu_is_self(cpu)) {
        qemu_cpu_kick(cpu);
    } else {
        qatomic_set(&cpu->neg.icount_decr.u16.high, -1);
    }
}
```

流程上可以理解为：

1. 设备或定时器触发中断，请求设置 `CPU_INTERRUPT_*` 位。
2. 若 vCPU 在别的线程，`qemu_cpu_kick()` 促使其从 TB 中退出。
3. vCPU 回到 `cpu_exec_loop`，在内层 `cpu_handle_interrupt()` 中消费中断。

## 中断处理路径：可延迟处理

当 `interrupt_request` 非空时，`cpu_handle_interrupt()` 会转给架构回调 `cpu_exec_interrupt()`：

```c
/* accel/tcg/cpu-exec.c */
if (tcg_ops->cpu_exec_interrupt(cpu, interrupt_request)) {
    if (unlikely(cpu->singlestep_enabled)) {
        cpu->exception_index = EXCP_DEBUG;
        return true;
    }
    cpu->exception_index = -1;
    *last_tb = NULL;
}
```

关键点：

- **是否真正触发中断**由目标架构决定（`cpu_exec_interrupt()` 返回值）。
- 处理完后通常需要清理 `exception_index`，并让 TB 链接失效（`last_tb = NULL`）。
- `CPU_INTERRUPT_EXITTB` 会强制退出 TB，但不一定代表“真正的外部中断”。

## 异常处理路径：需要立刻处理

异常通常需要立刻处理，由 `exception_index` 驱动，核心处理逻辑在 `cpu_handle_exception()`：

```c
/* accel/tcg/cpu-exec.c */
if (replay_exception()) {
    const TCGCPUOps *tcg_ops = cpu->cc->tcg_ops;

    bql_lock();
    tcg_ops->do_interrupt(cpu);
    bql_unlock();
    cpu->exception_index = -1;
}
```

这里的 `do_interrupt()` 才是**真正的异常处理入口**，由目标架构实现。例如非法指令、系统调用、访存异常都会进入这里。

## 异常/中断处理的钩子函数

TCG 将“通用循环”和“架构细节”分开，关键钩子定义在 `include/accel/tcg/cpu-ops.h`：

```c
/* include/accel/tcg/cpu-ops.h */
void (*do_interrupt)(CPUState *cpu);
bool (*cpu_exec_interrupt)(CPUState *cpu, int interrupt_request);
```

- `do_interrupt()`：处理同步异常（由 `exception_index` 指示）。
- `cpu_exec_interrupt()`：处理异步中断（由 `interrupt_request` 指示）。

这也是为什么不同架构的中断/异常行为差异很大：**真正的语义由 target 目录下的实现决定**。

## RISC-V 的异常与中断处理

RISC-V 的实现位于 `target/riscv/cpu_helper.c`。中断是否被接受由 `riscv_cpu_exec_interrupt()` 决定，它会将中断号编码进 `exception_index` 并直接调用 `riscv_cpu_do_interrupt()`：

```c
/* target/riscv/cpu_helper.c */
if (interrupt_request & mask) {
    int interruptno = riscv_cpu_local_irq_pending(env);
    if (interruptno >= 0) {
        cs->exception_index = RISCV_EXCP_INT_FLAG | interruptno;
        riscv_cpu_do_interrupt(cs);
        return true;
    }
}
```

RISC-V 用 `RISCV_EXCP_INT_FLAG` 表示“这是异步中断”，`exception_index` 的低位则是具体 cause。真正的陷入处理在 `riscv_cpu_do_interrupt()` 中完成，下面这段展示了陷入 S-mode 时的寄存器保存与向量跳转：

```c
/* target/riscv/cpu_helper.c */
env->scause = cause | ((target_ulong)async << (sxlen - 1));
env->sepc = env->pc;
env->stval = tval;
env->htval = htval;
env->htinst = tinst;
env->pc = (env->stvec >> 2 << 2) +
          ((async && (env->stvec & 3) == 1) ? cause * 4 : 0);
riscv_cpu_set_mode(env, PRV_S, virt);
```

它的行为与规范一致：保存 EPC/CAUSE/TVAl，按 `stvec` 的 direct/vectored 模式计算新 PC。若陷入未委派或在 M-mode 处理，则逻辑会切换为 `mcause/mepc/mtvec` 路径，整体结构保持相同。

## 章节小结

- **异常**是同步的，靠 `exception_index` 驱动，进入 `do_interrupt()`。
- **中断**是异步的，靠 `interrupt_request` 驱动，进入 `cpu_exec_interrupt()`。
- **处理时机**多在 TB 边界：中断/异常先让 TB 退出，再由主循环处理。
- **架构差异**决定最终行为，QEMU 只提供统一框架与调用时机。

!!! tip "进一步阅读"

    - QEMU Glossary：SoftMMU / system mode 的官方定义。[1]
    - QEMU 执行循环（TCG）解析文章。[2]
    - QEMU 讨论：为何中断在 TB 边界处理。[3]

[1]: https://www.qemu.org/docs/master/glossary.html
[2]: https://airbus-seclab.github.io/qemu_blog/exec.html
[3]: https://mail.gnu.org/archive/html/qemu-discuss/2020-08/msg00037.html
