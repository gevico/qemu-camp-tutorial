# QEMU 训练营 2026 项目阶段：用 LLM Agent 建模 QEMU 外设

!!! note "主要贡献者"

    - 作者：[@vsvnakers](https://github.com/vsvnakers)

---

本文总结 [qemu-LLM-agent](https://github.com/vsvnakers/qemu-LLM-agent) 项目：一个面向 QEMU 外设建模的小型、可审计的 LLM Agent。它读取硬件资料、驱动代码与 QEMU API 约束，分阶段生成 STM32F103 TIM2 设备模型、qtest 与验证报告，再用一份固定的 rubric 打分。任务与第一阶段 [PR #16](https://github.com/shandianchengzi/qemu/pull/16) 对齐。原始 Agent 产出在 rubric 下得 77/100（未过 80 分门槛），经人工审校后达 100/100、真实 qtest 9/9 通过；两组成绩分开记录，不把人工结果算作纯模型成绩。

## 1. 项目背景与目标

第一阶段我用「从寄存器存起来，到把硬件行为语义做对」的思路，为 QEMU `stm32f103` machine 补上了 TIM2 通用定时器。做完之后留下一个问题：建模里最耗时的部分，其实是资料筛选、寄存器语义整理、代码骨架生成、测试设计和反复 review，而非某一行 C 代码本身。LLM 恰好可以参与这些环节——但前提是把它放进一个受约束、可追踪、允许人工纠错的流程里。

因此这个项目不追求「无人值守生成任意外设」，而是回答一个更小的问题：给定一份任务输入（TRM 摘录 + 驱动访问序列 + QEMU API 约束），一个 LLM Agent 能在多大程度上独立产出「可编译、可测试、语义正确」的外设模型？差距又落在哪些地方？为此，把评分做成确定性的，把边界和溯源做成可审计的。

## 2. Agent 工作流

整个 Agent 只有两个 Python 文件：`agent.py`（生成与编排）和 `benchmark.py`（评分），没有第三方依赖，纯标准库调用 DeepSeek 的 chat completions 接口。

一次运行先收集 `tasks/stm32f103-tim2/` 下的输入（`task.md`、`reference.md`、`driver.c`、`qemu-api-notes.md`），对文件相对路径与内容做 SHA-256，得到本次运行的输入指纹。随后按 `staged` 策略分阶段生成五个必需产物：

| 阶段 | 产物 |
| --- | --- |
| plan | `plan.json`（需求、寄存器模型、行为模型、测试、假设与风险） |
| model | `hw/timer/stm32f1xx_timer.c`、`include/hw/timer/stm32f1xx_timer.h` |
| qtest | `tests/qtest/stm32f103-timer-test.c` |
| docs | `model-manifest.json`、`REPORT.md` |

每个阶段都要求模型返回严格 JSON 的 `files` 数组，`write_candidate` 只接受白名单里的路径，拒绝绝对路径与 `..` 穿越。生成结束后用 rubric 打分；若存在失败项，走 `repair` 流程把失败清单与当前候选回喂给模型，要求它针对性地修复而非敷衍加注释。也可以选择 `monolithic` 策略：单次生成全部文件，多次迭代取最高分。

每个产物都落盘，最终在 `run.json` 里记录输入指纹、模型、策略、每次 API 调用的 token 用量、各次尝试的得分与失败项。这让「哪次运行、什么输入、哪个模型、怎么来的」都有据可查。

## 3. 工程约束

几条约束贯穿始终，也是让 Agent 产物「可审查」的关键：

- **路径隔离**：模型只能写五个白名单路径，输出路径必须相对且不含 `..`，否则报错终止。
- **确定性评分**：rubric 是纯正则 + JSON 断言，不依赖模型自评；总分必须恰好 100。
- **诚实标注**：系统提示要求模型「只用任务输入里的事实、标注假设、不宣称未编译测试过的代码」。`REPORT.md` 必须显式声明生成产物尚未编译运行。
- **无依赖可复现**：WSL + Python 3.10+，纯标准库，`DEEPSEEK_API_KEY` 走环境变量，`.env*`、`runs/` 不提交。

## 4. Benchmark 设计

`benchmarks/stm32f103-tim2/rubric.json` 用 19 项检查覆盖 8 个类别，共 100 分，门槛 80：

| 类别 | 分值 | 检查项 |
| --- | ---: | --- |
| QEMU structure | 13 | 完整 SysBus/QOM 设备、迁移钩子 |
| Registers | 16 | 寄存器映射、MMIO 安全、复位值 |
| Timing behavior | 12 | 虚拟时间推演计数、deadline 向上取整 |
| Update control | 16 | CEN/UDIS、URS、OPM/ARPE 预装载 |
| Interrupts | 11 | 电平中断门控、SR rc_w0 |
| Output compare | 7 | 四通道输出比较与 CCMR 半字选择 |
| Validation | 19 | qtest 挂 machine、时序边界、中断、控制位 |
| Traceability | 6 | manifest schema、报告四要素 |

检查多为「必须出现的模式」——例如 `counter-time` 要求同时出现 `qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL)`、`active_psc + 1`、`active_arr + 1` 与 `muldiv64`，`round-up` 要求出现 `muldiv64_round_up`。这类半量化检查能快速筛掉「把寄存器存起来」的伪模型，但无法替代真实构建与 qtest，因此最终结论仍以实际 QEMU qtest 为准。

## 5. 结果与人工审校

| 产物 | Benchmark | QEMU qtest |
| --- | ---: | ---: |
| 原始 Agent（`raw-agent/`） | 77/100，FAIL | 未运行 |
| 人工审校版（`assisted/`） | 100/100，PASS | 9/9 PASS |

原始 Agent 通过了寄存器映射、复位、虚拟时间结构、更新控制、迁移与 traceability，但输在四个语义检查上：

- `rc-w0`：SR 清除写成 `flags &= ~written`，而 STM32 语义是写 0 清位，应为 `flags &= written`。
- `compare`：比较调度没有用 CCMR1/CCMR2 的 `CCxS` 排除输入通道。
- `qtest-timing`：测试缺少「deadline 前 1 ns」与「deadline 当拍」两侧的边界证明。
- `qtest-irq-compare`：清标志时写 1 而非写 0，且缺少同样的时序边界断言。

这几处都不是「少写一个寄存器」，而是真实的硬件语义偏差。人工审校用第一阶段已 review 的 TIM2 实现（commit `75475e550fd6488d2a803d5f6b85d9f347e18c93`）替换了设备源码、头文件与 qtest，保留 Agent 生成的 manifest 与报告，并把改动记入 `assisted/HUMAN_EDITS.md`。这样做是为了如实记录：100/100 不是纯模型成绩。

## 6. 与第一阶段 TIM2 建模的关系

这个项目是第一阶段 TIM2 工作的直接延伸：任务输入里的 `reference.md` 就是 RM0008 第 15 章的精读摘录，`driver.c` 是裸机固件的访问序列，`qemu-api-notes.md` 则是从第一阶段 PR 里沉淀出的「当前 QEMU tree 的构建/API 约束」。也就是说，Agent 吃进去的，正是上一阶段自己走过的建模路径。两阶段因此形成闭环：先亲手把 TIM2 做对，再把这条路径结构化成可复用的任务输入，让 LLM 试着重走一遍并量化差距。

## 7. 总结与心得

最有价值的不是「模型能生成多少行代码」，而是把「正确」变成可检查的东西：rubric 把硬件语义拆成 19 项机械断言，`run.json` 把每次运行钉在输入指纹上，`HUMAN_EDITS.md` 把人工介入显式暴露出来。原始 77 分与审校 100 分之间的落差，恰恰说明当前 LLM 在「寄存器能读写」与「硬件行为语义正确」之间仍隔着一段需要人工确认的距离；而这段距离，比再多生成几个寄存器更有意义。

对我而言，这也把第一阶段的收获推进了一步：从「把硬件行为语义做对」，到「把『做对』这件事本身变成可评分、可追踪、可复现的流程」。

## 8. 后续方向

- 把 rubric 从半量化正则升级为「可编译 + 可运行 qtest」的硬验证，让评分与真实构建结果一致。
- 补齐输入捕获、PWM 输出、从模式与 DMA 等剩余功能的建模任务，扩展 Agent 的能力边界。
- 接入 RCC 时钟门控与可配置时钟源，替换固定 72 MHz 近似。
- 将同一套任务框架推广到 TIM3～TIM5 或其他外设，验证 Agent 的可迁移性。

## 参考资料

\[1] 本项目仓库。 <https://github.com/vsvnakers/qemu-LLM-agent>

\[2] 第一阶段 QEMU PR。 <https://github.com/shandianchengzi/qemu/pull/16>

\[3] STMicroelectronics. RM0008: STM32F101xx, STM32F102xx, STM32F103xx, STM32F105xx and STM32F107xx advanced Arm-based 32-bit MCUs Reference Manual. <https://www.st.com/resource/en/reference_manual/rm0008-stm32f101xx-stm32f102xx-stm32f103xx-stm32f105xx-and-stm32f107xx-advanced-armbased-32bit-mcus-stmicroelectronics.pdf>

\[4] QEMU Camp 训练营。 <https://qemu.gevico.online/>
