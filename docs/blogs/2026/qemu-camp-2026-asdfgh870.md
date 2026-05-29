# QEMU 训练营 2026 专业阶段总结

!!! note "主要贡献者"

    - 作者：[@asdfgh870](https://github.com/asdfgh870)

---

## 背景介绍

本人是一位的操作系统行业工作4年的开发人员，对QEMU有一定的了解，但是具体的实现细节停留在李强的《qemu kvm底层源码剖析》理论中，眼过十遍不如手过一回，希望通过训练营的学习，深入理解QEMU的实现细节，结合实践和理论，提高自己的编程能力和对qemu的理解。

## 专业阶段

我选择了QEMU的CPU模拟器实验方向，通过学习QEMU的源码，我理解了CPU模拟器的基本原理和实现机制。
### 实验记录

#### 分析测试程序
分析当前使用的测试构建Makefile，找出其调用的qemu相关命令
``shell
qemu-system-riscv64 -M g233 -m 2G -display none -semihosting -device loader,file=./build/tests/gevico/tcg/riscv64-softmmu/test-insn-xxx
``
命令解析如下：
| 参数 | 作用 |
|------|------|
| `-M g233` | 使用 g233 机器类型 |
| `-m 2G` | 分配 2GB 内存 |
| `-semihosting` | **启用 semihosting 支持** |
| `-display none` | 不显示图形窗口 |
| `-device loader,file=xxx` | 加载测试程序到内存 |
##### QEMU Semihosting 工作原理

##### 1. 什么是 Semihosting？

**Semihosting**（半主机）是一种让运行在 QEMU 模拟器上的 guest 程序能够与 host 主机交互的技术。它允许 guest 程序使用宿主机的 I/O 资源（如打印输出、文件访问等）。

##### 2. Semihosting 调用序列

从 [crt.S#L61-68](tests/gevico/tcg/riscv64/crt/crt.S#L61-68) 可以看到 Semihosting 的调用序列：

```asm
_exit:
    lla    a1, semiargs
    li     t0, 0x20026    # ADP_Stopped_ApplicationExit
    sd     t0, 0(a1)
    sd     a0, 8(a1)
    li     a0, 0x20      # TARGET_SYS_EXIT_EXTENDED

    # Semihosting call sequence (magic sequence)
    slli   zero, zero, 0x1f   # 0xF0000000
    ebreak                   # 触发 ebreak 异常
    srai   zero, zero, 0x7   # 0x12345678 (会被 QEMU 特殊处理)
```

**关键点**：这是一个"魔法序列"（magic sequence），QEMU 识别这个特定模式后会拦截 `ebreak` 指令并执行 semihosting 调用。

##### 3. QEMU 如何处理 Semihosting

当 QEMU 执行 `ebreak` 指令时：

1. **Trap 捕获**：CPU 进入 trap 处理流程
2. **模式识别**：QEMU 检查 `slli zero, zero, 0x1f` 和 `srai zero, zero, 0x7` 这两个指令是否在 `ebreak` 前后
3. **参数传递**：
   - `a0` 寄存器包含 semihosting 功能号（如 `0x20` = `TARGET_SYS_EXIT_EXTENDED`）
   - `a1` 寄存器指向包含参数的结构体
4. **宿主执行**：QEMU 在宿主机上执行相应的 I/O 操作

##### CRT 文件夹结构解析

##### 📁 文件列表

```
tests/gevico/tcg/riscv64/crt/
├── crt.h          # 头文件 - 公共接口定义
├── crt.S          # 汇编文件 - 启动代码和 semihosting 调用
├── console.c      # 控制台 - printf 实现
├── memory.c       # 内存 - memset/memcpy 实现
├── semihost.ld    # 链接脚本 - 内存布局定义
└── pl011.h        # 设备 - PL011 UART 寄存器定义,不知道具体作用。
```

##### 📄 各个文件详细说明

##### **1. crt.h** - 公共头文件

提供测试程序使用的所有公共接口：

```c
#include <stdint.h>    // 标准整数类型
#include <stdbool.h>  // 布尔类型
#include <stddef.h>   // size_t 等
#include <stdarg.h>   // 可变参数支持
```

关键定义：
- `HARTID` - 宏，读取当前 hart id
- `crt_assert()` - 断言宏，失败时打印信息并退出
- `crt_abort()` - 异常终止函数
- `printf()` - 格式化输出函数

##### **2. crt.S** - 启动代码（汇编）

这是 **系统的入口点**！

| 代码段 | 功能 |
|--------|------|
| `_start:` | 系统启动入口 |
| `_init_bsp:` | 初始化 boot strap processor (BSP) |
| `trap:` | 异常处理向量 |
| `_exit:` | 程序退出（触发 semihosting） |

**启动流程**：
```
_start
  ├── 设置 mtvec (machine trap vector)
  ├── 初始化 sp (stack pointer) = 0x84000000 + hartid * 0x400000
  ├── _init_bsp() - 初始化 BSP
  ├── call main() - 调用用户程序
  └── _exit() - 通过 semihosting 退出
```

##### **3. console.c** - printf 实现

这是一个**不依赖任何库函数**的独立 printf 实现！

关键设计：
- 使用**固定缓冲区** `printbuf = (char *)0x82000000UL` 直接写入内存
- 通过 semihosting 的 `TARGET_SYS_WRITE0` 输出到宿主机
- 支持浮点数格式化输出

```c
static char *printbuf = (char *)0x82000000UL;  // 固定内存地址

int printf(const char *s, ...) {
    // 格式化字符串到 printbuf
    vsprintf(printbuf, s, args);
    // 通过 semihosting 输出 printbuf 内容，注意这里只是写入内存，不会立即发送到宿主机，需要在 _exit 中调用 semihosting_write0 发送
    semihosting_write0(printbuf);
}
```

##### **5. semihost.ld** - 链接脚本

定义程序在内存中的布局：

```ld
ENTRY(_start)

SECTIONS
{
    . = 0x80000000;          
    .text : { *(.text) }     /* 代码段 */
    .rodata : { *(.rodata) } /* 只读数据段 */
    
    . = ALIGN(1 << 21);      /* 对齐到 2MB */
    .data : { *(.data) }     /* 可读写数据段 */
    .bss : { *(.bss) }        /* 未初始化数据段 */
}
```
QEMU RISC-V virt 机器 的 RAM 通常映射从 0x80000000 开始，
. = 0x80000000; 表示代码段从 0x80000000 开始，qemu 运行时会加载可执行文件test-insn-xxx的代码到该地址处，然后执行0x80000000地址的指令。

**内存布局**：
```
0x80000000 +---------------------------+
           |         .text             |  代码段
           |---------------------------|
           |         .rodata           |  只读数据
           |---------------------------|
           | (对齐到 2MB)               |
           |---------------------------|
           |         .data             |  可读写数据
           |---------------------------|
           |         .bss              |  未初始化数据
0x84000000 +---------------------------+
```
当前内存布局符合start的实现
```assembly
# path: crt.S
    # sp size 0x400000
    csrr    a0, mhartid
    slli    a1, a0, 22
    # sp base 0x84000000
    li      sp, 0x84000000
```

##### **6. pl011.h** - PL011 UART 寄存器定义

PL011 是 ARM 的 UART（通用异步收发器）IP 核，这里的定义可能是为了支持 UART 输出（如果 semihosting 不可用）。

---

###### 测试程序结构示例

以 `test-insn-vdot.c` 为例：

```c
#include "crt.h"      // 包含所有必要的声明

#define VEC_LEN 16    // 私有宏定义

static int vec_a[VEC_LEN];  // 静态变量 (.data section)

int main(void)              // 程序入口 (由 crt.S 调用)
{
    test_vdot_basic();      // 业务逻辑
    printf("vdot: all tests passed\n");  // 输出到宿主机
    return 0;               // 返回给 crt.S 的 _exit
}
```
整个测试系统的设计思路是：**不依赖任何标准库或操作系统**，构建一个最小化的 C 运行时环境，让测试程序能够在 QEMU 模拟器上独立运行！

#### 2.指令模拟
模拟一个cpu扩展指令集的过程：
1.给对应型号添加一个指令集扩展，参考https://qemu.gevico.online/tutorial/2026/ch2/qemu-cpu-model/#6
2.创建decode文件，然后使用script/decode_tree.py 生成对应的decode.c.inc文件，关于decodetree的解释，可参考：https://qemu.gevico.online/tutorial/2026/ch2/qemu-insn/#decodetree
```shell
python3 ./scripts/decodetree.py target/riscv/xg233ai.decode # 在终端输出decode.c.inc内容，也可 -o 输出到文件
```
3.添加扩展对应的翻译函数
```c
// path: target/riscv/translate.c
const RISCVDecoder decoder_table[] = {
    { always_true_p, decode_insn32 },
    { has_xmips_p, decode_xmips},
    { has_xthead_p, decode_xthead},
    { has_XVentanaCondOps_p, decode_XVentanaCodeOps},
    {has_xg233_p, decode_xg233ai}
};
```
4. 补充模拟的指令对应的翻译函数
eg:
```c
// path: target/riscv/insn_trans/xg233ai.c.inc
typedef arg_r arg_sort;
static bool trans_sort(DisasContext *ctx, arg_sort *a) {
    gen_helper_sort(tcg_env, tcg_constant_tl(a->rd), tcg_constant_tl(a->rs1),tcg_constant_tl(a->rs2));
    return true;
}
```
翻译过程有以下两种方式：
1. 使用help模拟指令
2. 使用IR模拟指令
##### 1. 使用help模拟指令
参考：https://qemu.gevico.online/tutorial/2026/ch2/qemu-insn/
模拟指令过程就是仿照cube 的指令语义实现（采用 Helper 实现）：
```c
// target/riscv/helper.h
DEF_HELPER_3(cube, void, env, tl, tl)

// target/riscv/op_helper.c
void helper_cube(CPURISCVState *env, target_ulong rd, target_ulong rs1)
{
    MemOpIdx oi = make_memop_idx(MO_TEUQ, 0);
    target_ulong val = cpu_ldq_mmu(env, env->gpr[rs1], oi, GETPC());
    env->gpr[rd] = val * val * val;
}

// target/riscv/insn_trans/trans_rvi.c.inc
static bool trans_cube(DisasContext *ctx, arg_cube *a)
{
    gen_helper_cube(tcg_env, tcg_constant_tl(a->rd), tcg_constant_tl(a->rs1));
    return true;
}
```
需要注意的是，gen_helper_cube 函数是一个宏，会生成一个调用helper_cube 函数的TR 指令，而不是直接调用helper_cube 函数，trans_cube只是翻译作用，不会直接调用helper_cube 函数。
gen_helper_cube 是 DEF_HELPER_3(cube, void, env, tl, tl)生成的。
这里展示下宏对应定义：
以 `DEF_HELPER_FLAGS_4(dma, 0, void, env, tl, tl, tl)` 为例：
DEF_HELPER_3 对应了DEF_HELPER_4(dma, void, env, tl, tl, tl)

##### 第一步：展开宏定义
DEF_HELPER_4宏定义为
```c
// path: include/exec/helper-head.h.inc
#define DEF_HELPER_4(name, ret, t1, t2, t3, t4) \
    DEF_HELPER_FLAGS_4(name, 0, ret, t1, t2, t3, t4)
```

DEF_HELPER_FLAGS_4宏定义为:
```c
#define DEF_HELPER_FLAGS_4(name, flags, ret, t1, t2, t3, t4)            \
extern TCGHelperInfo glue(helper_info_, name);                          \
static inline void glue(gen_helper_, name)(dh_retvar_decl(ret)          \
    dh_arg_decl(t1, 1), dh_arg_decl(t2, 2),                             \
    dh_arg_decl(t3, 3), dh_arg_decl(t4, 4))                             \
{                                                                       \
    tcg_gen_call4(glue(helper_info_,name).func,                         \
                  &glue(helper_info_,name), dh_retvar(ret),             \
                  dh_arg(t1, 1), dh_arg(t2, 2),                         \
                  dh_arg(t3, 3), dh_arg(t4, 4));                        \
}
```

那么DEF_HELPER_4(dma, void, env, tl, tl, tl)展开后就是：
```c
extern TCGHelperInfo helper_info_dma;

static inline void gen_helper_dma(
    dh_retvar_decl(void)          // -> 空（void 无返回值）
    dh_arg_decl(env, 1),          // -> TCGv_ptr arg1
    dh_arg_decl(tl, 2),           // -> TCGv_i64 arg2
    dh_arg_decl(tl, 3),           // -> TCGv_i64 arg3
    dh_arg_decl(tl, 4)            // -> TCGv_i64 arg4
) {
    tcg_gen_call4(
        helper_info_dma.func,
        &helper_info_dma,
        dh_retvar(void),          // -> NULL
        dh_arg(env, 1),           // -> tcgv_ptr_temp(arg1)
        dh_arg(tl, 2),            // -> tcgv_i64_temp(arg2)
        dh_arg(tl, 3),            // -> tcgv_i64_temp(arg3)
        dh_arg(tl, 4)             // -> tcgv_i64_temp(arg4)
    );
}
```

##### 第二步：最终展开结果
```c
extern TCGHelperInfo helper_info_dma;

static inline void gen_helper_dma(
    TCGv_ptr arg1,
    TCGv_i64 arg2,
    TCGv_i64 arg3,
    TCGv_i64 arg4
) {
    tcg_gen_call4(
        helper_info_dma.func,
        &helper_info_dma,
        NULL,
        tcgv_ptr_temp(arg1),
        tcgv_i64_temp(arg2),
        tcgv_i64_temp(arg3),
        tcgv_i64_temp(arg4)
    );
}
```

##### 2. 使用IR模拟指令
使用IR 指令模拟实现了dma指令，确实实现起来比较繁琐，不如helper_XXX方便。


## 总结

通过tcg指令模拟实验，对qemu的tcg指令模拟有了深入的理解。并且具备了自行模拟指令，使用Semihosting模式验证模拟指令正确性的能力。