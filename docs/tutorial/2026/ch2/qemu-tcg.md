# QEMU TCG 介绍：二进制动态翻译原理和运行流程

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

QEMU 支持多种 accel，但大体可以分为两种：指令模拟技术（TCG）、虚拟化技术（KVM、HVF）等。QEMU 有两种主要的运行模式：System mode 模拟整个机器（CPU、内存和虚拟设备）以运行客户机操作系统；User mode 则允许在一个 CPU 架构上运行为另一个 CPU 编译的用户态进程，此时 CPU 始终被模拟，主要支持 Linux 用户态程序。

!!! tip "概览"

    - TCG 作为动态二进制翻译引擎的角色
    - IR 结构与 TB/BB 的基本概念
    - 翻译流程与执行路径
    - MTTCG 多线程模型
    - 跳转优化、代码缓存与性能分析

## 常见二进制翻译技术

- 解释器：Interpreter，每次解析并执行一条 Guest 指令，循环往复。

- 静态翻译：Static Binary Translation，在程序运行前进行翻译。运行时没有翻译开销，优化幅度有限。

- 动态翻译：Dynamic Binary Translation，在程序运行时动态翻译。一般按照程序 trace 翻译，不会全量翻译，能对热点代码进行深度优化。

我们主要聊聊 TCG(Tiny Code Generator) ，最初是一个 C 语言的编译器后端，后来演化为 QEMU 的二进制动态编译（翻译）引擎。除了 TCG，QEMU 还有一个 TCI（解释执行），但是目前用的较少。TCG 是一个 JIT（即时）编译器，用于在软件中模拟客户机 CPU。它是 QEMU 支持的加速器之一，支持多种客户机/主机架构组合。

!!! note "术语"

    - Guest：指被模拟的架构，例如 QEMU 模拟 Arm CPU 的代码位于 `target/arm/`。

    - Target：在 TCG 子系统中，它指的是 QEMU 本身运行的架构，即主机（Host），这是从早期作为编译器后端所演变来的术语习惯，代指翻译的目标架构。但在 QEMU 的其他部分，`target` 通常作为`guest` 的同义词。

## TCG IR 介绍

类似 LLVM，QEMU TCG 也定义有自己的中间表示（IR），流程如下：

```
+---------------+      +----------------+      +---------------+
|               |      |                |      |               |
| Source binary | ---> |    QEMU IR     | ---> | Target binary |
|     code      |      |                |      |     code      |
|               |      |                |      |               |
+---------------+      +----------------+      +---------------+
      Guest                                          Host
```

TCG IR 由强类型的操作（ops）和变量组成，操作的参数通常按“输出 -> 输入 -> 常量”的顺序表达，接口形式为 `tcg_gen_xxx()` 。

- 变量类型：`cpu_env` 是固定全局变量，指向 `CPUArchState`；`TEMP_GLOBAL` 映射到 `CPUArchState` 内存位置；`TEMP_CONST` 是 TB 内唯一化的常量；`TEMP_TB`/`TEMP_EBB` 仅在 TB 或扩展基本块内存活。

- 数据类型：`TCG_TYPE_I32/I64/PTR/REG` 是基础类型；64 位值在 32 位主机上会拆成多个子变量；向量类型需要后端支持。

- Helpers：由目标架构的 `helper.h` 生成，默认在调用前保存全局变量。可通过 `TCG_CALL_NO_WRITE_GLOBALS`、`TCG_CALL_NO_READ_GLOBALS`、`TCG_CALL_NO_SIDE_EFFECTS` 标注副作用。

- 优化：TCG 会在基本块级别做活性分析，消除死值与冗余移动；必要时可用 `discard_i32/i64` 提示值不会再使用。

!!! tip ""

    基于 IR 的优势:

    - 拓展性好：支持新的前端（Guest），只需要实现 source -> IR，工程量大幅度缩短；

    - 易于流程化：类似 LLVM，可以引入各种 pass，对不同环节进行优化。

    但是也存在劣势：

    - 性能普遍不高，但这是相对而言，相比解释执行，性能要高出 10 倍左右。

我们会在后续讲解指令翻译时，详细介绍 TCG ops 的种类及特征。


## TCG 翻译流程

TCG 的二进制转换是以客户机指令序列的代码块（基本块，Basic Block）为基本单元，翻译后的目标产物为翻译块（Translation Block，TB），对应为宿主机上可以运行的指令序列。注意，TCG 每次只会翻译一个 BB。

基本块的划分规则：分支指令；特权指令/异常；代码段跨页。

而翻译块是一个单入口、多出口区域，对应以标签或任何分支指令结束的指令序列。多个翻译块可以在特定条件下被合并到一起（下文的 chained TB），通常是是由零个或多个条件分支指令的直通路径连接起来的。

下面是每个翻译块执行的逻辑：

```
                        +---------------------+
         1)             |                     |
       +----------------+   QEMU TCG engine   +---------------+
       |          +---->|                     |<---+          |
       |          |     +----------+---^------+    |          |
       |          |                |   |   4)      |          | 5)
       |          |            3)  |   +------+    |          |
       v          |2)              v          |    | 6)       v
+---------------+ |        +---------------+  |    |  +---------------+
|   prologue    | |        |   prologue    |  |    |  |   prologue    |
+---------------+ |        +---------------+  |    |  +---------------+
|               | |        |               |  |    |  |               |
|  Translation  | |        |  Translation  |  |    |  |  Translation  |
|     Block1    | |        |     Block2    |  |    |  |     Block3    |
|               | |        |               |  |    |  |               |
+---------------+ |        +---------------+- |    |  +---------------+
|   epilogue    | |        |   epilogue    |  |    |  |   epilogue    |
+------+--------+ |        +-------+-------+  |    |  +------+--------+
       +----------+                +----------+    +---------+
```

当一个基本块（Basic Block，简称 BB）被转换为翻译块（TB）以后，下次再执行到相同的 BB 直接从缓存中获取 TB 执行即可，无需再经过转换：

```
                              +---------------+
       +----------------------| Do something  |-------------------+
       |                      +---------------+                   |
       v                                                          |
+--------------+       +----------------+ Y       +---------+     |
|   Guest PC   +------>| Check TB Cache +-------->| Exec TB +-----+
+--------------+       +------+---------+         +---------+
                              | N                      ^
                              v                        |
                        +-------------+                |
                        | translation |                |
                        +-----+-------+                |
                              v                        |
                       +-----------------+             |
                       |Save TB to Cache +-------------+
                       +-----------------+
```

为了加速执行，QEMU 后来开发了多线程 TCG（Multi-threaded TCG，MTTCG），可以利用多核 CPU 提升性能。

QEMU TCG 中 vCPU 取指令（发生在翻译前夕）一般发生在以下场景：

- 翻译客户机代码时：通过客户机虚拟地址（Guest VA）得到客户机物理地址（Guest PA），再映射到主机虚拟地址（Host VA），从而读取指令。

- 搜索 TB 哈希表时：用 Guest PA 和其他参数作为 key 查找已翻译的 TB。

- 链式 TB 跳转时：由于限制在同一客户机页内，跳转不需要重新翻译或搜索，但跨页时则需回退到上述两种方式。

这种设计平衡了直接跳转的性能和跨页处理的复杂性。

另外，QEMU 通过 `longjmp()` 从异常处回到主循环，SIGSEGV/SIGBUS 处理器负责把 host PC 映射回 guest PC。某些状态（如 x86 条件码、SPARC delay slot、Arm 条件执行）可能只在 TB 结束时回写，因此需要为每条 guest 指令保留必要的状态信息，以便发生异常时还原精确状态。

在用户态仿真中，生成 TB 时会将包含该代码的主机页设置为写保护；若发生写入触发 SIGSEGV，QEMU 会失效该页上的 TB 并解除保护。系统态仿真通过软件 MMU 处理。为正确撤销链式跳转，QEMU 会维护页内 TB 链表及跳转关系并在失效时清理。

在系统模式下，QEMU 通过 softmmu 会在每次访存时完成虚实转换，TLB 缓存用于加速。TB 以物理地址索引，避免映射变化时频繁失效；链式跳转仅在同页内进行，减少跨页映射变化带来的不一致。RAM/ROM 访问可直接使用 host 偏移，MMIO 则调用 C 代码处理，同时也用于脏页与 TB 所在页的跟踪。

> 我们后续会通过单独的章节，详细讲解 softmmu 的实现。

## 多线程 TCG

多线程 TCG（MTTCG）为系统模式提供每 vCPU 一线程的运行模型，在满足 host 内存模型和 guest 支持时默认启用；若使用 `-accel tcg,thread=single` 或 `-icount` 则退回单线程轮转。

- 热路径结构：`tb_jmp_cache`（每 vCPU）与 `tb_ctx.htable`（全局）支持无锁/原子查找，只有代码生成与 TB 跳转回填需要加锁。

- 代码生成：用户态仿真共享翻译缓冲区，生成与回填需要 `mmap_lock()` 串行化；系统模式每 vCPU 拥有独立 TCG 上下文与 region，翻译期锁需求更少。

- 失效与回填：TB 失效时需要撤销直跳并更新页面索引、缓存与哈希，回填/撤销过程通过原子更新和必要的锁保护。

- TLB 同步：跨 vCPU 的 TLB flush 通过“安全工作”同步机制使各 vCPU 进入可安全修改状态。

## 直接跳转优化

拿 x86_64 作为 Host 平台举例，每次执行上下文切换需要执行大约 20 条指令 (指令还会进行内存的读写)，

因此 DBT 的优化措施之一就是减少上下文切换，实现 TB 之间的直接链接：

```
            1)          +---------------------+
       +----------------+   QEMU TCG engine   +---------------------------+
       |                +---------------------+                           |
       v                                                                  |
+---------------+          +---------------+          +---------------+   |
|   prologue    |          |   prologue    |   3)     |   prologue    |   |
+---------------+ +------> +---------------+  +-----> +---------------+   |
|               | |        |               |  |       |               |   | 5)
|  Translation  | |        |  Translation  |  |       |  Translation  |   |
|     Block1    | |        |     Block2    |  |       |     Block3    |   |
|               | |2)      |               |  |       |               |   |
+---------------+-+        +---------------+--+       +---------------+---+
|   epilogue    |          |   epilogue    |          |   epilogue    |
+------+--------+          +-------+-------+          +------+--------+

```

TCG 在 TB 内假设部分 CPU 状态恒定（如特权级、段基址等），这些状态被记录在 TB 中；当状态变化时会生成新的 TB，旧 TB 暂停使用直到状态再次匹配。

执行路径上有两类“快速直跳”机制：

- `lookup_and_goto_ptr`：发出查找 TB 的 helper，若命中则直接跳转，否则回到 epilogue 并重新进入主循环（以便重新评估中断等状态）。

- `goto_tb + exit_tb`：先用跳转槽位发出 `goto_tb`，更新 CPU 状态后 `exit_tb` 返回主循环；主循环找到目标 TB 后会回填跳转槽，下次即可直接跳转。

`goto_tb + exit_tb` 需要分支目标可静态确定且不跨页，否则仍需回到主循环以重新查找并检查中断。

!!! tip "注意事项"

    两个 chained TB 对应的 Guest 指令需要在同一个 Guest page 内。这是为了保证地址翻译的效率和一致性。当客户机代码跨越不同页时，QEMU 取指令必须通过翻译客户机代码或搜索 TB 哈希表，这两种方式都需要进行客户机虚拟地址到物理地址的翻译。


## 代码缓存管理

在 qemu 启动的早期会执行一个函数叫 tcg_init_machine, 完成 code_buffer 的申请和初始化，code_buffer 用于管理翻译块的缓存。

```
code_buffer = mmap()
|                                             TCGContext.code_ptr
v                                              v
+-----------+----------+-------------+---------+------------------+
|           |          |             |         |                  |
|  prologue | epilogue |  TB.struct  | TB.code |     ...          | size = Host / dynamic_code_size
|           |          |             |         |                  |
+-----------+----------+-------------+---------+------------------+
^           ^                        ^
|           |                        |
|           tcg_code_gen_epilogue    |
|                                    tb.tc.ptr
tcg_qemu_tb_exec
```

在 coder_buffer 的开头，会首先创建对应当前 Host 的上下文切换的 prologue 和 epilogue，类似 C 语言函数调用的序言和结尾。用于从 Host 世界切换到 Guest 世界。每次生成 TB，会按照现生成管理当前 TB 的结构体，再生成 TB 本身的顺序来写入 code_buffer。

当 code_buffer 的容量不足时，会进行 TB flush，刷掉全部的 TB，再重新生成。

- 后续所有代码翻译和执行的工作，都围绕 code_buffer 展开

- TCGContext 的后端管理工作，也是围绕 code_buffer 进行

## TCG 插件

TCG 插件（TCG Plugins）是一个用于在系统模式和用户模式下对客户机代码进行插桩的 API。其最终目标是实现与 DynamoRIO 或 Valgrind 类似的功能集。QEMU 插件的一个关键优势是能够执行与架构无关的插桩。

- 版本管理：插件需导出 `qemu_plugin_version`，核心会校验 API 版本范围，`qemu_info_t` 提供最小/当前版本信息。

- 生命周期：插件在 `qemu_plugin_install` 中注册回调，结束时可通过 `atexit` 回调输出统计；卸载是异步的。

- 翻译/执行回调：可在 TB 翻译回调中枚举指令并注册执行回调；指令回调发生在指令执行前。

- 内存回调：仅在成功的 load/store 之后触发，fault 不会触发内存回调。

- 句柄有效期：TB/指令/内存句柄只在回调期间有效，需要及时复制信息。

- 性能优化：可使用 inline op 与 scoreboard 做轻量统计，配合条件回调减少开销。

## TCG 性能分析

QEMU 支持 `-perfmap` 与 `-jitdump` 生成 host/guest 映射，配合 Linux `perf` 进行性能分析。

`-jitdump` 还能导出 JIT 代码与调试信息，但需要后续 `perf inject` 合并到 `perf.data`。注意 `qemu-system` 仅对 `-kernel` 的 ELF 输出映射。

常用命令如下：

```bash
# 轻量级性能分析，仅生成 guest↔host 映射，直接 perf report
perf record $QEMU -perfmap $REMAINING_ARGS
perf report

# 会保存 JIT 代码与调试信息，需先 perf inject 合并到 perf.data 再报告
perf record -k 1 $QEMU -jitdump $REMAINING_ARGS
DEBUGINFOD_URLS= perf inject -j -i perf.data -o perf.data.jitted
perf report -i perf.data.jitted
```

注意，qemu-system 只对 -kernel 指定的 ELF 文件生成映射。
