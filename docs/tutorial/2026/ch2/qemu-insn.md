# QEMU 模拟指令：指令译码与实现

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

本章介绍 QEMU 如何模拟客户机指令，主要从指令译码与指令行为实现两个方面展开。

!!! tip "概览"

    - Decodetree 译码机制与语法结构
    - 字段/参数集合/格式/模式的定义方法
    - 指令实现与 helper/TCG ops 的关系
    - 示例与验证流程
    - 练习与扩展方向

## 指令译码

### Decodetree 概述

Decodetree 是 Bastian Koppelmann 于 2017 年在移植 RISC-V QEMU 时提出的机制。提出该机制的主要原因是，过去的指令解码器（如 ARM）多通过大量 switch-case 进行判断，既难读也难维护。

因此他提出 Decodetree：开发者只需用其语法定义各指令的格式，Decodetree 即可动态生成包含 switch-case 的指令解码器源码。

Decodetree 本质是一个 Python 脚本，输入为体系结构的指令格式定义文件，输出为指令解码器源码文件。

```
+-----------+           +-----------+            +-------------------+
| arch-insn |   input   |  scripts/ |   output   | decode-@BASENAME@ |
|  .decode  +---------->| decode.py +----------->|       .c.in       |
+-----------+           +-----------+            +-------------------+
```

- input: 体系结构的指令编码格式定义文件
- output: 指令解码器源码（参与 QEMU 编译）

Decodetree 的语法共分为四部分：Fields、Argument Sets、Formats、Patterns。

- Fields：描述指令编码中的寄存器、立即数等字段；
- Argument Sets：描述用于保存从指令中提取出的各字段值的数据结构；
- Formats：描述指令的格式，并生成相应的 decode function；
- Pattern：描述一条指令的 decode 方式。

### Decodetree 字段

Field 用于定义如何从一条指令中提取各字段（如 rd、rs1、rs2、imm）的值。

```
field_def     := '%' identifier ( unnamed_field )* ( !function=identifier )?
unnamed_field := number ':' ( 's' ) number  eg: %rd 7:5 => insn[11:7]
```

- identifier 可由开发者自定，如 rd、imm 等
- unnamed_field 定义该字段所在的比特/位域，s 字符用于标明取出字段后是否需要做符号扩展
- !function 指定在截取字段值后需要调用的函数


```c
以 RISC-V 的 U-type 指令为例：
31                              12  11                 7  6    0
+----------------------------------+--------------------+------+
|            imm[31:12]            |         rd         |opcode| U-type
+----------------------------------+--------------------+------+

可声明为：
%rd       7:5
%imm_u    12:s20                 !function=ex_shift_12

最后会生成如下的代码：
static void decode_insn32_extract_u(DisasContext *ctx, arg_u *a, uint32_t insn)
{
    a->imm = ex_shift_12(ctx, sextract32(insn, 12, 20)); // 是由 insn[31:12] 所取得并做符号扩展，且会再调用 ex_shift_12() 来左移 12 个 bits
    a->rd = extract32(insn, 7, 5); // 由 insn[11:7] 所取得
}
```

### Decodetree 参数集合

Argument Set 用于保存从指令中截取的各字段值。

```
args_def    := '&' identifier ( args_elt )+ ( !extern )?
args_elt    := identifier
```

- identifier 可由开发者自定义，如 regs、loadstore 等
- !extern 表示是否已在其他地方由其他 decoder 定义过。若已定义，则不会再次生成对应的 argument set 结构体

```c
# U-type 指令格式示例
&u    imm rd

# 生成如下代码
typedef struct {
    int imm;
    int rd;
} arg_u;
```

### Decodetree 格式

Format 用于描述指令格式（如 RISC-V 的 R、I、S、B、U、J-type），并生成对应的 decode function。

```
fmt_def      := '@' identifier ( fmt_elt )+
fmt_elt      := fixedbit_elt | field_elt | field_ref | args_ref
fixedbit_elt := [01.-]+
field_elt    := identifier ':' 's'? number
field_ref    := '%' identifier | identifier '=' '%' identifier
args_ref     := '&' identifier
```

- identifier 可由开发者自定义，如 opr、opi 等

- fmt_elt 可采用以下语法：
    - fixedbit_elt 包含一个或多个 `0`、`1`、`.`、`-`，每个代表指令中的 1 个 bit。
        `.` 代表该 bit 可以是 0 或 1。
        `-` 代表该 bit 会被忽略。

- field_elt 可以用 Field 的语法来声明，如 ra:5、rb:5、lit:8

- field_ref 有两种格式（以下示例参考上文所定义的 Field）：
    - `'%' identifier`：直接引用一个已定义的 Field。

        - 如：`%rd`，会生成：
        ```
        a->rd = extract32(insn, 7, 5);
        ```

    - `identifier '=' '%' identifier`：引用一个已定义的 Field，并用左侧 identifier 重命名对应的 argument 名称。此方式可用不同的 argument 名称指向同一个 Field

        - 如：`my_rd=%rd`，会生成：
        ```
        a->my_rd = extract32(insn, 7, 5)
        ```
    - args_ref 指定 decode function 所使用的 Argument Set。若未指定 args_ref，Decodetree 会根据 field_elt 或 field_ref 自动生成一个 Argument Set。此外，一个 Format 最多只能包含一个 args_ref

!!! note

    当 fixedbit_elt 或 field_ref 被使用时，该 Format 的所有 bit 都必须被定义（可通过 `fixedbit_elt` 或 `.` 填满，空格会被忽略）。

```
@opi    ...... ra:5 lit:8    1 ....... rc:5
```

- insn[31:26] 可为 0 或 1
- insn[25:21] 为 ra，insn[20:13] 为 lit
- insn[12] 固定为 1
- insn[11:5] 可为 0 或 1
- insn[4:0] 为 rc

此 Format 会生成以下的 decode function：

```c
// 由于我们没有指定 args_ref，因此 Decodetree 根据 field_elt 的定义自动生成了 arg_decode_insn320 这个 Argument Set
typedef struct {
    int lit;
    int ra;
    int rc;
} arg_decode_insn320;
static void decode_insn32_extract_opi(DisasContext *ctx, arg_decode_insn320 *a, uint32_t insn)
{
    a->ra = extract32(insn, 21, 5);
    a->lit = extract32(insn, 13, 8);
    a->rc = extract32(insn, 0, 5);
}
```

以 RISC-V I-type 指令为例：

```
31           20 19    15 14     12  11                 7  6    0
+--------------+--------+----------+--------------------+------+
|   imm[11:0]  |  rs1   |  funct3  |         rd         |opcode| I-type
+--------------+--------+----------+--------------------+------+

# Fields:
%rs1       15:5
%rd        7:5

# immediates:
%imm_i    20:s12

# Argument sets:
&i    imm rs1 rd

@i       ........ ........ ........ ........ &i      imm=%imm_i     %rs1 %rd
```

此范例会生成以下的 decode function：

```
typedef struct {
    int imm;
    int rd;
    int rs1;
} arg_i;

static void decode_insn32_extract_i(DisasContext *ctx, arg_i *a, uint32_t insn)
{
    a->imm = sextract32(insn, 20, 12);
    a->rs1 = extract32(insn, 15, 5);
    a->rd = extract32(insn, 7, 5);
}
```

回到前面的 RISC-V U-type 指令，我们可以按 I-type 指令的方式定义其格式：

```
# Fields:
%rd        7:5

# immediates:
%imm_u    12:s20                 !function=ex_shift_12

# Argument sets:
&u    imm rd

@u       ....................      ..... ....... &u      imm=%imm_u          %rd
```

会生成以下的 decode function：

```
typedef struct {
    int imm;
    int rd;
} arg_u;

static void decode_insn32_extract_u(DisasContext *ctx, arg_u *a, uint32_t insn)
{
    a->imm = ex_shift_12(ctx, sextract32(insn, 12, 20));
    a->rd = extract32(insn, 7, 5);
}
```

### Decodetree 模式

Pattern 用于定义一条指令的 decode 方式。Decodetree 会根据 Patterns 的定义，动态生成对应的 switch-case 解码分支。

```
pat_def      := identifier ( pat_elt )+
pat_elt      := fixedbit_elt | field_elt | field_ref | args_ref | fmt_ref | const_elt
fmt_ref      := '@' identifier
const_elt    := identifier '=' number
```

- identifier 可由开发者自定义，如 addl_r、addli 等

- pat_elt 可采用以下语法：

    - fixedbit_elt 与 Format 中 fixedbit_elt 的定义相同。
    - field_elt 与 Format 中 field_elt 的定义相同。
    - field_ref 与 Format 中 field_ref 的定义相同。
    - args_ref 与 Format 中 args_ref 的定义相同。
    - fmt_ref 直接引用一个已定义的 Format。
    - const_elt 可以直接指定某个 argument 的值。

Pattern 示例：

```
addl_i   010000 ..... ..... .... 0000000 ..... @opi
```

该 Pattern 定义了 addl_i 指令，其中：

- insn[31:26] 为 010000。
- insn[11:5] 为 0000000。
- 参考了 Format 示例中定义的 @opi Format。
- 由于 Pattern 的所有 bits 都必须**明确地定义**，因此 @opi 必须包含其余 insn[25:12] 及 insn[4:0] 的格式定义，否则 Decodetree 会报错。

最后 addl_i 的 decoder 会调用 trans_addl_i() 这个 translator 函数。

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

### Helper 实现

Helper 允许 QEMU 使用 C 函数来实现 TCG ops 无法直接或表达起来较复杂的指令语义，并由 host 编译器优化 Helper 的实现。比如 RISC-V 的 RVV 扩展，直接使用 TCG ops 需要手写大量 IR 且容易出错。

Helper 函数的使用方式与普通 C 程序类似。对于不了解 TCG ops 的开发人员来说，使用 Helper 也可以帮助他们快速实现指令行为，只需了解 C 语言即可。

添加 cube 的指令语义实现（采用 Helper 实现）：

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

### TCG ops 介绍

前面我们讲了如何使用 QEMU 的 Helper 函数来模拟指令功能，但一般情况下，Helper 主要用于 IR 实现不方便的场景。

若希望获得更好的性能，推荐使用 IR 来实现。

TCG 的前端负责将目标架构的指令转换为 TCG op，而 TCG 的后端则负责将 TCG ops 转换为目标架构的指令。

本节我们主要讲 TCG 的前端，讨论常用的 TCG ops 的用法。

!!! note
    推荐阅读：[Documentation/TCG/frontend-ops][1]

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

#### 位运算

对单个寄存器的逻辑运算：

```c
// ret = !arg1
// Negation: Logical NOT an register
tcg_gen_not_tl(ret, arg1);
```

对两个寄存器的逻辑运算：

```c
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

#### 循环移位

```c
// ret = arg1 rotl arg2
// Circular_shift: Rotate left one register by magnitude of another
tcg_gen_rotl_tl(ret, arg1, arg2);

// ret = arg1 rotr arg2
// Circular_shift Rotate right one register by magnitude of another
tcg_gen_rotr_tl(ret, arg1, arg2);
```

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

#### 读写内存

用于在寄存器与任意主机内存之间搬运数据。

通常用于那些未由专用寄存器表示、且不常用的 CPU 状态。

这些并不是用来访问目标内存空间的。

访问目标内存请参考下文的 QEMU_XX helpers。

```c
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

用于在寄存器与任意目标内存之间搬运数据。

用于 load/store 的地址始终是第二个参数，第一参数始终是要加载/存储的值。

第三个参数（memory index）仅对 system target 有意义；user target 始终传入 0。

```c
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

### 练习

!!! tip "任务"

    请尝试使用 Helper 和 TCG ops 来分别实现 cube 指令，并编写一个简单的 benchmark 程序来对比他们的性能差距。

[1]: https://wiki.qemu.org/Documentation/TCG/frontend-ops
