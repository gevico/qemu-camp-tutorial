# QEMU 模拟指令：指令译码与实现

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

!!! info "QEMU 版本"

    本文基于 QEMU **v10.2.0**（tag: [`v10.2.0`](https://gitlab.com/qemu-project/qemu/-/tags/v10.2.0)，commit: `75eb8d57c6b9`）。

本章介绍 QEMU 如何模拟客户机指令，主要从指令译码与指令行为实现两个方面展开。

!!! tip "概览"

    - Decodetree 译码机制与语法结构
    - 字段/参数集合/格式/模式的定义方法
    - 指令实现与 helper/TCG ops 的关系
    - 示例与验证流程
    - 练习与扩展方向

---

## 指令译码

### 整体流程：一条指令从二进制到翻译函数

在深入语法细节之前，先理解 QEMU 对一条 guest 指令做了什么。以 RISC-V 的 `add x5, x6, x7` 为例，它的 32 位编码是：

```
0000000 00111 00110 000 00101 0110011
 funct7  rs2   rs1  f3   rd    opcode
```

QEMU 的处理分为三步：

1. **译码（decode）**：从 32 位二进制中提取 `rd`、`rs1`、`rs2` 等字段，并匹配到具体指令。
2. **翻译（translate）**：调用与该指令对应的 `trans_add()` 函数，生成 TCG 中间表示。
3. **执行**：TCG 后端将 IR 编译为 host 指令并运行。

其中第 1 步和第 2 步的衔接就是 Decodetree 的职责所在。

```
guest 指令 (32-bit 二进制)
    │
    ▼
decode_insn32()                ← decodetree.py 自动生成
  ① 匹配固定 bit 位 → 确定是哪条指令
  ② 提取字段 → 填入 arg 结构体
  ③ 调用 trans_xxx(ctx, arg_xxx *a)
    │  例如 arg_r { .rd=5, .rs1=6, .rs2=7 }
    ▼
trans_add(ctx, arg_r *a)       ← 开发者手写
  读取 rs1、rs2 寄存器 → 生成加法 TCG op → 写回 rd 寄存器
    │
    ▼
TCG 后端编译为 host 指令并执行
```

### Decodetree 是什么

Decodetree 是 Bastian Koppelmann 于 2017 年在移植 RISC-V 时提出的译码机制。在此之前，各架构的解码器通常用大量手写 switch-case 实现——既难读也难维护。Decodetree 的核心思路是：**开发者只需声明式地描述指令编码格式，由 Python 脚本自动生成 switch-case 解码器源码**。

```
+----------------+           +---------------+            +-----------------------+
| target/arch/   |  input    | scripts/      |  output    | decode-@BASENAME@     |
| insn32.decode  +---------->| decodetree.py +----------->|     .c.inc            |
+----------------+           +---------------+            +-----------------------+
```

`.decode` 文件是开发者编写的声明式描述，`decodetree.py` 读取它后生成 `.c.inc` 文件，该文件在编译时被 `#include` 到翻译函数所在的 C 源码中。

### 四层抽象：从字段到指令

Decodetree 的 `.decode` 文件由四层声明组成，每一层解决一个具体问题：

```
Field（字段提取器）
│   定义"从第几位开始取多少位"
│   例如：%rd  7:5  →  "从 insn 的第 7 位开始，取 5 位"
│
│  被引用 ▼
Argument Set（字段容器）
│   定义"这类指令需要哪些字段"→ 生成 C 结构体
│   例如：&r  rd rs1 rs2  →  typedef struct { int rd; int rs1; int rs2; } arg_r;
│
│  被引用 ▼
Format（编码布局模板）
│   定义"这类指令的 bit layout"，组合 Field 和 Argument Set
│   例如：@r  ....... ..... ..... ... ..... .......  &r  %rs2 %rs1 %rd
│   → 生成 decode_insn32_extract_r() 函数
│
│  被引用 ▼
Pattern（具体指令）
    定义"匹配这些固定 bit → 用这个 Format → 调这个 trans 函数"
    例如：add  0000000 ..... ..... 000 ..... 0110011  @r
    → 匹配成功后调用 trans_add(ctx, &u.f_r)
```

一句话总结四者的分工：

| 层级 | 解决的问题 | 类比 |
|------|-----------|------|
| **Field** | 如何从 32 位指令中切出某个字段 | "取第 7~11 位" |
| **Argument Set** | 这类指令需要哪些字段 | "R-type 需要 rd、rs1、rs2" |
| **Format** | 一类指令的完整 bit 布局 | "R-type 是 funct7-rs2-rs1-funct3-rd-opcode" |
| **Pattern** | 一条具体指令的匹配规则 | "funct7=0000000 + funct3=000 + opcode=0110011 就是 add" |

接下来逐层介绍。每个小节都会以 RISC-V R-type 指令（`add`、`sub` 等）为主线示例，它们对应的真实代码位于 `target/riscv/insn32.decode`。

---

### Field：字段提取器

Field 回答的问题是：**"我想从 32 位指令编码中的哪个位置、取多少位，作为某个字段的值？"**

以 RISC-V 为例，几乎所有指令都包含 `rd`（目标寄存器）字段，位于 insn[11:7]：

```
31                 12  11   7  6   0
+-------------------+-------+------+
|       ...         |  rd   | ...  |
+-------------------+-------+------+
```

对应的 Field 定义：

```
%rd    7:5
```

含义：从 insn 的**第 7 位**开始，取 **5 位**。Decodetree 会据此生成 `extract32(insn, 7, 5)` 来提取。

#### 符号扩展

立即数字段通常需要符号扩展。例如 RISC-V I-type 的 12 位立即数 `imm[11:0]` 位于 insn[31:20]，需要符号扩展到 32/64 位：

```
%imm_i    20:s12
```

`s` 前缀表示做符号扩展（sign-extend）。生成代码为 `sextract32(insn, 20, 12)` 而非 `extract32`。

#### 多段拼接与后处理函数

有些字段由多个不连续的位段拼接而成。例如 RISC-V B-type 的立即数 `imm[12|10:5|4:1|11]` 分散在 4 个位置：

```
%imm_b    31:s1 7:1 25:6 8:4     !function=ex_shift_1
```

多个 `位起:宽度` 对会从左到右依次拼接。`!function=ex_shift_1` 指定拼接后再调用 `ex_shift_1()` 做左移 1 位的后处理。这是实际中最复杂的 Field 用法。

!!! info "语法参考"

    ```
    field_def     := '%' identifier ( unnamed_field )* ( !function=identifier )?
    unnamed_field := number ':' ( 's' ) number
    ```

    - `identifier`：字段名，如 `rd`、`imm_i`
    - `unnamed_field`：`起始位:宽度` 或 `起始位:s宽度`（`s` 表示符号扩展）
    - `!function=xxx`：提取完成后调用函数 `xxx` 做后处理

---

### Argument Set：字段容器

Argument Set 回答的问题是：**"这类指令译码后，需要把哪些字段打包传给 trans 函数？"**

为什么需要它？因为**多条指令共享相同的字段集合**。RISC-V 中 `add`、`sub`、`and`、`or` 等 R-type 指令都需要 `rd`、`rs1`、`rs2` 三个字段。如果每条指令都单独声明一遍字段，既冗余又不一致。Argument Set 把公共字段集合抽取出来：

```
&r    rd rs1 rs2
```

Decodetree 会生成对应的 C 结构体，这个结构体正是 `trans_add(ctx, arg_r *a)` 中第二个参数的类型：

```c
typedef struct {
    int rd;
    int rs1;
    int rs2;
} arg_r;
```

因此在 `trans_add` 中通过 `a->rs1` 即可访问到译码阶段提取的字段值。

类似地，I-type 指令（`addi`、`ori` 等）共享 `&i imm rs1 rd`，U-type 指令（`lui`、`auipc`）共享 `&u imm rd`。

!!! info "语法参考"

    ```
    args_def    := '&' identifier ( args_elt )+ ( !extern )?
    args_elt    := identifier
    ```

    - `!extern`：表示此 Argument Set 已在其他 `.decode` 文件中定义过，不需要再次生成结构体。用于多个 decoder 文件共享同一个 Argument Set 的场景。

---

### Format：编码布局模板

Format 回答的问题是：**"这类指令的 32 个 bit 各自是什么含义？"** 它把 Field 和 Argument Set 组合在一起，描述完整的 bit 布局，并据此生成 extract 函数。

以 RISC-V R-type 为例。它的编码格式是：

```
31     25 24  20 19  15 14  12 11   7 6    0
+--------+------+------+-----+------+------+
| funct7 | rs2  | rs1  | f3  |  rd  |opcode|
+--------+------+------+-----+------+------+
```

对应的 Format 定义（取自 `target/riscv/insn32.decode`）：

```
@r    .......   ..... ..... ... ..... .......  &r  %rs2 %rs1 %rd
```

逐列解读：

```
@r    .......   .....  .....  ...  .....  .......  &r       %rs2     %rs1     %rd
      ↑funct7   ↑rs2   ↑rs1  ↑f3  ↑rd    ↑opcode  ↑argset  ↑field   ↑field   ↑field
      7个.      5个.   5个.  3个. 5个.   7个.     &r       %rs2     %rs1     %rd
```

- 每个 `.` 代表一个"可以是 0 或 1"的 bit（即不参与匹配，由 Field 定义来提取）
- `&r` 指定使用 `arg_r` 结构体来保存提取结果
- `%rs2`、`%rs1`、`%rd` 引用前面定义的 Field，告诉 Decodetree 从哪里提取这些字段

Decodetree 据此生成 extract 函数：

```c
static void decode_insn32_extract_r(DisasContext *ctx, arg_r *a, uint32_t insn)
{
    a->rs1 = extract32(insn, 15, 5);
    a->rd  = extract32(insn, 7, 5);
    a->rs2 = extract32(insn, 20, 5);
}
```

这就是 `trans_add(ctx, arg_r *a)` 中 `a` 结构体被填充的过程。

#### 再看 I-type：立即数的处理

I-type 的 Format 更好地展示了立即数字段如何与 Field 配合：

```
@i    ............  .....  ...  .....  .......  &i  imm=%imm_i  %rs1 %rd
      ↑imm[11:0]   ↑rs1   ↑f3  ↑rd    ↑opcode
      12个.
```

其中 `imm=%imm_i` 意味着：结构体的 `imm` 成员由 `%imm_i` 这个 Field 提取（从 insn[31:20] 取 12 位并符号扩展）。`%imm_i` 的定义见上文 Field 节。

生成的 extract 函数：

```c
static void decode_insn32_extract_i(DisasContext *ctx, arg_i *a, uint32_t insn)
{
    a->imm = sextract32(insn, 20, 12);
    a->rs1 = extract32(insn, 15, 5);
    a->rd  = extract32(insn, 7, 5);
}
```

#### fixedbit：固定匹配位

除了 `.` 以外，Format 中还可以用 `0` 和 `1` 表示该 bit **必须**是 0 或 1。例如 `@atom_ld` 格式：

```
@atom_ld  ..... aq:1 rl:1 ..... ........ ..... .......  &atomic  rs2=0  %rs1 %rd
```

其中 `aq:1 rl:1` 是内联的 field_elt，直接在 Format 中声明字段而非引用 Field。`rs2=0` 是 const_elt，将 `rs2` 固定为 0。

!!! info "语法参考"

    ```
    fmt_def      := '@' identifier ( fmt_elt )+
    fmt_elt      := fixedbit_elt | field_elt | field_ref | args_ref
    fixedbit_elt := [01.-]+
    field_elt    := identifier ':' 's'? number
    field_ref    := '%' identifier | identifier '=' '%' identifier
    args_ref     := '&' identifier
    ```

    - `fixedbit_elt`：`0`/`1` 表示必须匹配的固定 bit，`.` 表示无关 bit，`-` 表示忽略 bit
    - `field_elt`：内联字段声明（如 `aq:1`），不需要单独定义 Field
    - `field_ref`：引用已定义的 Field
        - `%rd`：直接引用
        - `my_rd=%rd`：引用 Field 并重命名结构体成员（不同的 argument 名指向同一个 Field）
    - `args_ref`：指定 Argument Set，一个 Format 最多一个

    !!! warning

        当 Format 包含 fixedbit_elt 或 field_ref 时，所有 bit 位都必须被定义（用 `0`/`1`/`.` 填满），空格会被忽略。未指定 `args_ref` 时，Decodetree 会根据 field_elt/field_ref 自动生成一个 Argument Set。

---

### Pattern：具体指令

Pattern 回答的问题是：**"这条具体指令的 opcode 和 funct 字段是什么？"** 它通过固定 bit 位来匹配一条指令，并引用 Format 来处理其余字段。

以 `add` 为例（`target/riscv/insn32.decode:159`）：

```
add    0000000  .....  .....  000  .....  0110011  @r
       ^^^^^^^         ^^^^^  ^^^         ^^^^^^^
       funct7          rs2    funct3      opcode
       固定为           Format 提取       固定为
       0000000                            0110011
```

Decodetree 生成的匹配逻辑大致如下（简化）：

```c
case 0x00000033:                          // opcode = 0110011
    switch (insn & 0x3e007000) {
    case 0x00000000:                      // funct3 = 000
        decode_insn32_extract_r(ctx, &u.f_r, insn);
        switch ((insn >> 30) & 0x3) {
        case 0x0:                         // funct7 = 0000000
            if (trans_add(ctx, &u.f_r)) return true;    // ← 调用 trans 函数
            break;
        case 0x1:                         // funct7 = 0100000
            if (trans_sub(ctx, &u.f_r)) return true;
            break;
        }
        break;
    // ... funct3 = 001, 010, ... 各分支
    }
```

关键规则：

- **Pattern 名字决定 trans 函数名**：`add` → `trans_add()`，`sub` → `trans_sub()`
- **固定 bit 位用于匹配**：`0000000`、`000`、`0110011` 这些是必须精确匹配的
- **其余位通过 `@fmt` 引用 Format 处理**：Format 中的 field_ref（如 `%rs2`）负责提取对应位置的字段值
- **Pattern 的所有 bit 都必须被定义**：固定 bit + Format 中对应的位必须覆盖全部 32 bit

#### 重叠 Pattern 与分组

当多条指令共享部分编码时，可以用 `{ ... }` 分组表达重叠。例如 RISC-V 中 `auipc` 和 `lpad` 共享同一个 opcode：

```
{
  lpad   label:20    00000 0010111
  auipc  .................... 0010111 @u
}
```

Decodetree 会按定义顺序依次尝试匹配，先尝试 `lpad`（更具体的），不匹配则回退到 `auipc`。

!!! info "语法参考"

    ```
    pat_def   := identifier ( pat_elt )+
    pat_elt   := fixedbit_elt | field_elt | field_ref | args_ref | fmt_ref | const_elt
    fmt_ref   := '@' identifier
    const_elt := identifier '=' number
    ```

    - `fmt_ref`：引用 Format（如 `@r`）
    - `const_elt`：直接给某个 argument 赋常量值（如 `rs2=0`）
    - 其余语法与 Format 相同

---

### 端到端走查：`add x5, x6, x7` 的完整旅程

现在用一条真实指令走完全程，串联所有概念。

#### 第一步：指令编码

`add x5, x6, x7` 汇编后（rd=5, rs1=6, rs2=7, funct7=0, funct3=0, opcode=0x33）：

```
0000000 00111 00110 000 00101 0110011  =  0x007302B3
```

#### 第二步：`.decode` 文件中的声明

```
# Field：告诉 Decodetree 从哪里提取各字段
%rs2       20:5
%rs1       15:5
%rd        7:5

# Argument Set：打包为 arg_r 结构体
&r    rd rs1 rs2

# Format：描述 R-type 的 bit 布局
@r    ....... ..... ..... ... ..... ....... &r %rs2 %rs1 %rd

# Pattern：匹配 add 的固定 bit 位
add   0000000 ..... ..... 000 ..... 0110011 @r
```

#### 第三步：decodetree.py 生成的代码

**结构体**（由 `&r` 生成）：

```c
typedef struct {
    int rd;
    int rs1;
    int rs2;
} arg_r;
```

**Extract 函数**（由 `@r` + 引用的 Field 生成）：

```c
static void decode_insn32_extract_r(DisasContext *ctx, arg_r *a, uint32_t insn)
{
    a->rs1 = extract32(insn, 15, 5);   // %rs1  15:5
    a->rd  = extract32(insn, 7, 5);    // %rd   7:5
    a->rs2 = extract32(insn, 20, 5);   // %rs2  20:5
}
```

**匹配逻辑**（由 `add` Pattern 的固定 bit 生成，以下仅为概念演示，实际代码见 `decode-insn32.c.inc`）：

```c
case 0x00000033:                             // opcode 匹配 0110011
    decode_insn32_extract_r(ctx, &u.f_r, insn);
    if ((insn & 0xfe000000) == 0x00000000    // funct7 匹配 0000000
        && (insn & 0x00007000) == 0x00000000) // funct3 匹配 000
    {
        if (trans_add(ctx, &u.f_r)) return true;
    }
```

#### 第四步：trans 函数执行

此时 `u.f_r` 中已经填好了 `{ .rd=5, .rs1=6, .rs2=7 }`。Decodetree 会为每条指令生成类型别名（`typedef arg_r arg_add`），所以 `trans_add` 的参数类型是 `arg_add *` 而非 `arg_r *`——底层结构完全相同，这样做可以在编译期捕获不同指令类型之间的误用。

```c
static bool trans_add(DisasContext *ctx, arg_add *a)
{
    return gen_arith(ctx, a, EXT_NONE, tcg_gen_add_tl, tcg_gen_add2_tl);
}
```

`gen_arith` 内部从 `a->rs1`、`a->rs2` 读取 guest 寄存器值，用 `tcg_gen_add_tl` 生成加法 TCG op，结果写回 `a->rd` 对应的 guest 寄存器。

#### 回顾：数据流全貌

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

---

## 指令实现

### 指令设计与译码

现在我们设计一条 RISC-V 的算术指令 cube，指令编码格式遵循 R-type，语义为：`rd = [rs1] * [rs1] * [rs1]`。然后使用 QEMU TCG 中常用的两种方式：TCG ops 和 Helper 来实现它。

```c
31      25 24  20 19    15 14     12  11                7 6     0
+---------+--------+--------+----------+-------------------+-------+
|  func7  |  rs2   |  rs1   |  funct3  |         rd        | opcode| R-type
+---------+--------+--------+----------+-------------------+-------+
     6                         6                            0x7b
+---------+--------+--------+----------+-------------------+-------+
| 000110  | 00000  |  rs1   |    110   |         rd        |1111011| cube
+---------+--------+--------+----------+-------------------+-------+

```

---

客户机示例 C 代码如下：

```c
static int custom_cube(uintptr_t addr)
{
    int cube;
    asm volatile (
       ".insn r 0x7b, 6, 6, %0, %1, x0"
        :"=r"(cube)  // 将结果存储在变量 cube 中
        :"r"(addr)); // 将变量 addr 的值作为输入
    return cube;
}
```

在 QEMU 中添加 cube 的指令译码：

```c
// target/riscv/insn32.decode
@r_cube  ....... ..... .....    ... ..... ....... %rs1 %rd
cube     0000110 00000 .....    110 ..... 1111011 @r_cube
```

---

### Helper 实现

Helper 允许 QEMU 使用 C 函数来实现 TCG ops 无法直接或表达起来较复杂的指令语义，并由 host 编译器优化 Helper 的实现。比如 RISC-V 的 RVV 扩展，直接使用 TCG ops 需要手写大量 IR 且容易出错。

Helper 函数的使用方式与普通 C 程序类似。对于不了解 TCG ops 的开发人员来说，使用 Helper 也可以帮助他们快速实现指令行为，只需了解 C 语言即可。

添加 cube 的指令语义实现（采用 Helper 实现）：

```c {data-ppt-lines="10"}
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

---

### 示例程序与验证

编写一个简单的客户机示例程序来验证：

```c
int main(void) {
    int a = 3;
    int ret = 0;
    ret = custom_cube((uintptr_t)&a);
    if (ret == a * a * a) {
        printf("ok!\n");
    } else {
        printf("err! ret=%d\n", ret);
    }
    return 0;
}
```

编译运行测试：

```bash
$ riscv64-linux-musl-gcc main.c -o cube_demo --static
$ qemu-riscv64 cube_demo
ok!
```

---

### TCG ops 介绍

前面我们讲了如何使用 QEMU 的 Helper 函数来模拟指令功能，但一般情况下，Helper 主要用于 IR 实现不方便的场景。

若希望获得更好的性能，推荐使用 IR 来实现。

TCG 的前端负责将目标架构的指令转换为 TCG op，而 TCG 的后端则负责将 TCG ops 转换为目标架构的指令。

本节我们主要讲 TCG 的前端，讨论常用的 TCG ops 的用法。

!!! note
    推荐阅读：[Documentation/TCG/frontend-ops][1]

---

TCG ops 的基本格式如下：

```
tcg_gen_<op>[i]_<reg_size>(TCGv<reg_size> args, ...)

op: 操作类型
i: 操作数数量
reg_size: 寄存器大小（32/64/tl）
args: 操作数列表
```

#### 寄存器

```
TCGv reg = tcg_global_mem_new(TCG_AREG0, offsetof(CPUState, reg), "reg");
```

---

#### 临时变量

```c
// Create a new temporary register
TCGv tmp = tcg_temp_new();

// Create a local temporary register.
// Simple temporary register cannot carry its value across jump/brcond,
// only local temporary can.
TCGv tmpl = tcg_temp_local_new();

// Free a temporary register
tcg_temp_free(tmp);
```

#### 标签

```c
// Create a new label
int l = gen_new_label();

// Label the current location.
gen_set_label(l);
```

---

#### 常规运算

操作单个寄存器：

```c
// ret = arg1
// Assignment_(mathematical_logic): Assign one register to another
tcg_gen_mov_tl(ret, arg1);

// ret = - arg1
// Negation: Negate the sign of a register
tcg_gen_neg_tl(ret, arg1);
```

---

操作两个寄存器：

```c
// ret = arg1 + arg2
// Addition: Add two registers
tcg_gen_add_tl(ret, arg1, arg2);

// ret = arg1 - arg2
// Subtraction: Subtract two registers
tcg_gen_sub_tl(ret, arg1, arg2);

// ret = arg1 * arg2
// Multiplication: Multiply two signed registers and return the result
tcg_gen_mul_tl(ret, arg1, arg2);

// ret = arg1 * arg2
// Multiplication: Multiply two unsigned registers and return the result
tcg_gen_mulu_tl(ret, arg1, arg2);

// ret = arg1 / arg2
// Division_(mathematics): Divide two signed registers and return the result
tcg_gen_div_tl(ret, arg1, arg2);

// ret = arg1 / arg2
// Division_(mathematics): Divide two unsigned registers and return the result
tcg_gen_divu_tl(ret, arg1, arg2);

// ret = arg1 % arg2
// Division_(mathematics): Divide two signed registers and return the remainder
tcg_gen_rem_tl(ret, arg1, arg2);

// ret = arg1 % arg2
// Division_(mathematics) Divide two unsigned registers and return the remainder
tcg_gen_remu_tl(ret, arg1, arg2);
```

---

#### 位运算

对单个寄存器的逻辑运算：

```c
// ret = !arg1
// Negation: Logical NOT an register
tcg_gen_not_tl(ret, arg1);
```

对两个寄存器的逻辑运算：

```c  { data-ppt-lines="10" }
// ret = arg1 & arg2
// Logical_conjunction: Logical AND two registers
tcg_gen_and_tl(ret, arg1, arg2);

// ret = arg1 | arg2
// Logical_disjunction: Logical OR two registers
tcg_gen_or_tl(ret, arg1, arg2);

// ret = arg1 ^ arg2
// Exclusive_or: Logical XOR two registers
tcg_gen_xor_tl(ret, arg1, arg2);

// ret = arg1 ↑ arg2
// Logical_NAND: Logical NAND two registers
tcg_gen_nand_tl(ret, arg1, arg2);

// ret = arg1 ↓ arg2
// Logical_NOR Logical NOR two registers
tcg_gen_nor_tl(ret, arg1, arg2);

// ret = !(arg1 ^ arg2)
// Logical_equivalence: Compute logical equivalent of two registers
tcg_gen_eqv_tl(ret, arg1, arg2);

// ret = arg1 & ~arg2
// Logical AND one register with the complement of another
tcg_gen_andc_tl(ret, arg1, arg2);

// ret = arg1 ~arg2
// Logical OR one register with the complement of another
tcg_gen_orc_tl(ret, arg1, arg2);
```

---

#### 移位

```c
// ret = arg1 >> arg2 /* Sign fills vacant bits */
// Arithmetic shift right one operand by magnitude of another
tcg_gen_sar_tl(ret, arg1, arg2);

// ret = arg1 << arg2
// Logical_shift Logical shift left one registerby magnitude of another
tcg_gen_shl_tl(ret, arg1, arg2);

// ret = arg1 >> arg2
// Logical_shift Logical shift right one register by magnitude of another
tcg_gen_shr_tl(ret, arg1, arg2);
```

---

#### 循环移位

```c
// ret = arg1 rotl arg2
// Circular_shift: Rotate left one register by magnitude of another
tcg_gen_rotl_tl(ret, arg1, arg2);

// ret = arg1 rotr arg2
// Circular_shift Rotate right one register by magnitude of another
tcg_gen_rotr_tl(ret, arg1, arg2);
```

---

#### 字节操作

```c
// ret = ((arg1 & 0xff00) >> 8) // ((arg1 & 0xff) << 8)
// Endianness Byte swap a 16bit register
tcg_gen_bswap16_tl(ret, arg1);

// ret = ...see bswap16 and extend to 32bits...
// Endianness Byte swap a 32bit register
tcg_gen_bswap32_tl(ret, arg1);


// ret = ...see bswap32 and extend to 64bits...
// Endianness Byte swap a 64bit register
tcg_gen_bswap64_tl(ret, arg1);

// ret = (int8_t)arg1
// Sign extend an 8bit register
tcg_gen_ext8s_tl(ret, arg1);

// ret = (uint8_t)arg1
// Zero extend an 8bit register
tcg_gen_ext8u_tl(ret, arg1);

// ret = (int16_t)arg1
// Sign extend an 16bit register
tcg_gen_ext16s_tl(ret, arg1);

// ret = (uint16_t)arg1
// Zero extend an 16bit register
tcg_gen_ext16u_tl(ret, arg1);

// ret = (int32_t)arg1
// Sign extend an 32bit register
tcg_gen_ext32s_tl(ret, arg1);

// ret = (uint32_t)arg1
// Zero extend an 32bit register
tcg_gen_ext32u_tl(ret, arg1);

```

---

#### 读写内存

用于在寄存器与任意主机内存之间搬运数据。

通常用于那些未由专用寄存器表示、且不常用的 CPU 状态。

这些并不是用来访问目标内存空间的。

访问目标内存请参考下文的 QEMU_XX helpers。

```c  { data-ppt-lines="10" }
// Load an 8bit quantity from host memory and sign extend
tcg_gen_ld8s_tl(reg, cpu_env, offsetof(CPUState, reg));

// Load an 8bit quantity from host memory and zero extend
tcg_gen_ld8u_tl(reg, cpu_env, offsetof(CPUState, reg));

// Load a 16bit quantity from host memory and sign extend
tcg_gen_ld16s_tl(reg, cpu_env, offsetof(CPUState, reg));

// Load a 16bit quantity from host memory and zero extend
tcg_gen_ld16u_tl(reg, cpu_env, offsetof(CPUState, reg));

// Load a 32bit quantity from host memory and sign extend
tcg_gen_ld32s_tl(reg, cpu_env, offsetof(CPUState, reg));

// Load a 32bit quantity from host memory and zero extend
tcg_gen_ld32u_tl(reg, cpu_env, offsetof(CPUState, reg));

// Load a 64bit quantity from host memory
tcg_gen_ld64_tl(reg, cpu_env, offsetof(CPUState, reg));

// Alias to target native sized load
tcg_gen_ld_tl(reg, cpu_env, offsetof(CPUState, reg));

// Store a 8bit quantity to host memory
tcg_gen_st8_tl(reg, cpu_env, offsetof(CPUState, reg));

// Store a 16bit quantity to host memory
tcg_gen_st16_tl(reg, cpu_env, offsetof(CPUState, reg));

// Store a 32bit quantity to host memory
tcg_gen_st32_tl(reg, cpu_env, offsetof(CPUState, reg));

// Alias to target native sized store
tcg_gen_st_tl(reg, cpu_env, offsetof(CPUState, reg));

```

---

用于在寄存器与任意目标内存之间搬运数据。

用于 load/store 的地址始终是第二个参数，第一参数始终是要加载/存储的值。

第三个参数（memory index）仅对 system target 有意义；user target 始终传入 0。

```c  { data-ppt-lines="15" }
// ret = *(int8_t *)addr
// Load an 8bit quantity from target memory and sign extend
tcg_gen_qemu_ld8s(ret, addr, mem_idx);

// ret = *(uint8_t *)addr
// Load an 8bit quantity from target memory and zero extend
tcg_gen_qemu_ld8u(ret, addr, mem_idx);

// ret = *(int8_t *)addr
// Load a 16bit quantity from target memory and sign extend
tcg_gen_qemu_ld16s(ret, addr, mem_idx);

// ret = *(uint8_t *)addr
// Load a 16bit quantity from target memory and zero extend
tcg_gen_qemu_ld16u(ret, addr, mem_idx);

// ret = *(int8_t *)addr
// Load a 32bit quantity from target memory and sign extend
tcg_gen_qemu_ld32s(ret, addr, mem_idx);

// ret = *(uint8_t *)addr
// Load a 32bit quantity from target memory and zero extend
tcg_gen_qemu_ld32u(ret, addr, mem_idx);

// ret = *(uint64_t *)addr
// Load a 64bit quantity from target memory
tcg_gen_qemu_ld64(ret, addr, mem_idx);

// *(uint8_t *)addr = arg
// Store an 8bit quantity to target memory
tcg_gen_qemu_st8(arg, addr, mem_idx);

// *(uint16_t *)addr = arg
// Store a 16bit quantity to target memory
tcg_gen_qemu_st16(arg, addr, mem_idx);

// *(uint32_t *)addr = arg
// Store a 32bit quantity to target memory
tcg_gen_qemu_st32(arg, addr, mem_idx);

// *(uint64_t *)addr = arg
// Store a 64bit quantity to target memory
tcg_gen_qemu_st64(arg, addr, mem_idx);
```

---

#### 控制流

```c
// if (arg1 <condition> arg2) goto label
// Test two operands and conditionally branch to a label
tcg_gen_brcond_tl(TCG_COND_XXX, arg1, arg2, label);

// Goto translation block (TB chaining)
// Every TB can goto_tb to max two other different destinations. There are
// two jump slots. tcg_gen_goto_tb takes a jump slot index as an arg,
// 0 or 1. These jumps will only take place if the TB's get chained,
// you need to tcg_gen_exit_tb with (tb // index) for that to ever happen.
// tcg_gen_goto_tb may be issued at most once with each slot index per TB.
tcg_gen_goto_tb(num);

// Exit translation block
// num may be 0 or TB address ORed with the index of the taken jump slot.
// If you tcg_gen_exit_tb(0), chaining will not happen and a new TB
// will be looked up based on the CPU state.
tcg_gen_exit_tb(num);

// ret = arg1 <condition> arg2
// Compare two operands
tcg_gen_setcond_tl(TCG_COND_XXX, ret, arg1, arg2);

```

---

### IR 实现示例

下面我们使用 IR 来实现 cube 指令：

```c
static bool trans_cube(DisasContext *ctx, arg_cube *a)
{
    TCGv dest = tcg_temp_new(); // 申请一个临时变量
    TCGv rd = get_gpr(ctx, a->rd, EXT_NONE); // 获取 rd 寄存器
    // 读取 rs1 寄存器的值指向的内存的值，存储到 dest 中
    tcg_gen_qemu_ld_tl(dest, get_gpr(ctx, a->rs1, EXT_NONE), ctx->mem_idx, MO_TEUQ);
    // 计算 cube 并存储到 rd 寄存器中
    tcg_gen_mul_tl(rd, dest, dest); // rd = dest * dest
    tcg_gen_mul_tl(rd, rd, dest); // rd = rd * dest
    gen_set_gpr(ctx, a->rd, rd);
    return true;
}
```

---

### 练习

!!! tip "任务"

    请尝试使用 Helper 和 TCG ops 来分别实现 cube 指令，并编写一个简单的 benchmark 程序来对比他们的性能差距。

[1]: https://wiki.qemu.org/Documentation/TCG/frontend-ops
