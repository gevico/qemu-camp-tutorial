# QEMU 训练营 2026 专业阶段总结

!!! note "主要贡献者"

```
- 作者:[@Eclipse-Arrebol](https://github.com/Eclipse-Arrebol)
```

------

## 背景介绍

电子信息研一,有点liunx应用和驱动的基础，了解一点内核。

参加训练营的动机比较直接:

- B 站上刷到泽文老师的宣传,听完确实被吸引住了。
- 想给自己找点之后求职的项目

## 专业阶段

### 方向与项目演化

我选的是 GPU 方向。最初目标只是完成实验本身——在 QEMU 里实现一个虚拟 GPU 设备。但写着写着想法就开始膨胀了:

> 既然 QEMU 设备都写了,要不顺手写个配套的 Linux 驱动?
>  既然驱动都写了,要不让它真的能被用户态用起来?
>  既然 runtime 都有了,要不在上面跑个真实模型?

最后整个项目演变成了一个**基于 QEMU 虚拟 GPU 的自研 GPGPU 软件栈**,从底到上覆盖了:

```text
QEMU 虚拟 GPU 设备 (PCI device + RV32 SIMT 解释器)
    ↓
Linux PCI 驱动 (字符设备 /dev/gpgpu,mmap + ioctl)
    ↓
用户态 runtime libgpgpu (VRAM buddy/slab 分配器、kernel launch)
    ↓
手写 RV32 GPU kernels (GEMM / RMSNorm / RoPE / Softmax / SiLU / ...)
    ↓
Qwen2-0.5B token-level greedy 推理 demo
```

项目地址:https://github.com/Eclipse-Arrebol/gpgpu_driver

下面按实现顺序记录几块核心模块。它更像开发笔记,不追求把每个抽象包装得很漂亮,而是尽量解释「为什么这个 toy GPU 软件栈能跑起来」。

------

## 一、QEMU 设备侧:把一个虚拟 GPU 挂到 PCI 总线上

设备侧代码放在 QEMU 源码树的 `hw/gpgpu/`,主要分两层:

```text
gpgpu.c       QEMU PCI device / BAR / MMIO / interrupt
gpgpu_core.c  RV32 SIMT core interpreter
```

### QOM 注册

QEMU 里加设备的标准动作是走 QOM。`gpgpu_type_info` 里声明类型:

```text
name          = "gpgpu"
parent        = TYPE_PCI_DEVICE
instance_size = sizeof(GPGPUState)
class_init    = gpgpu_class_init
```

然后:

```c
type_register_static(&gpgpu_type_info);
type_init(gpgpu_register_types)
```

`gpgpu_class_init()` 里填的是 PCI 设备的身份信息:vendor_id、device_id、revision、class_id、realize、exit、reset、properties 这些字段。


### realize:实例化一个虚拟 GPU

`gpgpu_realize()` 是设备真正被创建时跑的:

1. `g_malloc0()` 分配一大块 host 内存当 VRAM
2. `memory_region_init_io()` 创建 BAR0 控制寄存器窗口
3. `pci_register_bar(..., 0, ...)` 把 BAR0 挂到 PCI 配置空间
4. `memory_region_init_io()` 创建 BAR2 VRAM 窗口
5. `pci_register_bar(..., 2, ...)` 把 BAR2 暴露给 guest
6. 创建 BAR4 doorbell 窗口
7. 初始化 MSI/MSI-X 相关结构
8. 创建 kernel completion timer

做完这些之后,guest 里启动的 Linux 看到的就是一台标准 PCI 设备。

### MMIO:控制寄存器、VRAM、中断

BAR0 是控制寄存器窗口,`gpgpu_ctrl_read()` / `gpgpu_ctrl_write()` 处理 guest 对这一段的读写。驱动会往这些寄存器写:

```text
KERNEL_ADDR_LO / HI
KERNEL_ARGS_LO / HI
GRID_DIM_X/Y/Z
BLOCK_DIM_X/Y/Z
SHARED_MEM_SIZE
DISPATCH
IRQ_ENABLE
```

`DISPATCH` 寄存器是触发点。guest 一旦写它,QEMU 侧依次做:

```text
gpgpu_dispatch_validate()
gpgpu_core_exec_kernel()
timer_mod(kernel_timer, now + 100ms)
```

注意 `gpgpu_core_exec_kernel()` 是同步执行的——直接在 QEMU 进程里解释跑完整个 kernel。然后挂一个 timer 模拟"延迟完成",timer 触发 `gpgpu_kernel_complete()`,设置 `KERNEL_DONE` 状态位,再通过:

```c
pci_irq_assert()
pci_irq_deassert()
```

把中断拉给 guest。Legacy INTx,不是 MSI-X——这是后面驱动那一节会再讲到的一个坑。

BAR2 的实现就非常直白:

```c
memcpy(&val, s->vram_ptr + addr, size);  // read
memcpy(s->vram_ptr + addr, &val, size);  // write
```

guest 对 BAR2 的 load/store 最终就是 QEMU 进程里 `vram_ptr` 那段 host 内存的读写。

------

## 二、RV32 SIMT 解释器:用 C 模拟一颗小 GPU core

`gpgpu_core.c` 是设备侧最有意思的部分。没有走 TCG,也没有真正生成机器码,而是手写了一个 RV32 指令解释器。

### 指令集

支持的指令大致这些:

- load/store:`lb / lbu / lw / sb / sw`
- integer imm:`addi / slli / slti / sltiu / xori / ori / andi / srli / srai`
- integer reg:`add / sub / mul / sll / slt / sltu / xor / div / srl / sra / or / rem / and`
- branch:`beq / bne / blt / bge / bltu / bgeu`
- jump:`jal / jalr`
- CSR:主要用 `mhartid`
- float load/store:`flw / fsw`
- float arithmetic:`fadd.s / fsub.s / fmul.s / fdiv.s / fsqrt.s / fmin / fmax`
- float compare / move / convert:`flt / feq / fsgnj / fmv / fcvt`
- FMA:`fmadd.s`

为了支撑模型算子,又额外加了几条自定义/扩展指令:

- `vexp.s`:直接用 host `expf()` 算指数,给 softmax 用
- bf16 / fp8 转换实验
- `vshfl`:warp 内 shuffle

写解释器有一个非常容易踩的坑:FP register 里实际存的是 32-bit 位模式,不是 C 的 `float` 类型。所以每条 FP 指令的开头和结尾都得显式做:

```c
u32_to_float()
float_to_u32()
```

RMSNorm、`fmv`、`fsgnj` 这几个地方都因为这个边界出过问题。

### warp、lane 和 mhartid

设备侧用 `GPGPUWarp` 表示一个 warp,用 `GPGPULane` 表示一个 lane。每个 lane 自己有:

```text
gpr[32]
fpr[32]
pc
active
mhartid
```

`gpgpu_core_exec_kernel()` 按 grid / block / warp 三层遍历:

```text
for block z/y/x
    for warp in block
        init warp
        a0 = kernel_args
        exec warp
```

init warp 的时候把 block id、warp id、thread id 全编进 `mhartid` 里。GPU kernel 通过读 `mhartid` 拿到自己的身份,再反向推 thread id、block id。设计很糙,但够用。

### warp shuffle:用 snapshot 做 lane 间通信

RMSNorm、softmax 这种算子需要 warp 内规约,得让 lane 互相看到对方的值。这里走的是一个自定义 `vshfl`:

1. 先把当前 warp 所有 lane 的源寄存器拍成 snapshot
2. 对活跃 mask 里的每个 lane 算:

```text
src_lane = lane_id ^ laneMask
dst = snapshot[src_lane]
```

是 CUDA 里 shuffle xor 那个用法,可以拿来写树形规约。

有一个简化前提:shuffle 最好发生在 warp-uniform 的上下文里——也就是参与 shuffle 的 lane 集合保持一致。严重分歧路径下做 shuffle 的语义和真实 GPU 不一定对得上。手写 kernel 的时候尽量让需要 shuffle 的地方保持全 warp 参与,绕开了这个坑。

### 分歧执行:min-PC scheduling

真实 GPU 处理 warp divergence 是有 reconvergence stack 或类似机制的。这里没做完整 reconvergence,而是用了一个极简策略:每一轮在 active lanes 里找最小 PC,只执行 PC 等于这个最小值的那部分 lane。

```text
while active_mask != 0:
    min_pc = min(lane.pc for active lane)
    current_mask = lanes whose pc == min_pc
    insn = fetch(min_pc)
    execute insn for current_mask
```

好处是实现极其简单。lane 分歧之后不同 PC 分批跑,等它们回到同一个 PC 又会自然合到一起执行。

但有一个明显的副作用:如果一部分 lane 进了一个 PC 较小的循环(`while (...) { ... }`),另一部分已经跳到更大的 PC,调度器会一直优先 PC 小的那批。只要小 PC 那批不退出循环,大 PC 那批就长期等着,看起来像饥饿。

所以这个策略对教学和简单算子够用,但不是完整 GPU divergence 模型。要更接近真实硬件得引入 reconvergence token/stack,或者至少做更公平的 PC group 调度。

------

## 三、`gpgpu_drv.ko`:一个最小可用的 PCI GPU 驱动

驱动是标准 Linux PCI driver。内核发现 vendor / device id 匹配的设备,会调它的 `gpgpu_probe()`:

1. `pci_enable_device()` 启用设备
2. `pci_request_regions()` 认领 BAR 资源
3. `pci_iomap()` 映射 BAR0 / BAR2 / BAR4
4. 读控制寄存器里的 device id 和 VRAM size
5. 注册字符设备 `/dev/gpgpu`
6. 注册中断——当前用 Legacy INTx
7. 打开设备侧 interrupt enable

为什么是 Legacy INTx 而不是 MSI-X?因为 RISC-V `virt` 机型的 PLIC 不支持 MSI-X,试了一圈最后退回 INTx。

整个驱动没碰 DRM/GPU 子系统,选了一条非常直接的路:把虚拟 GPU 暴露成字符设备。用户态打开 `/dev/gpgpu`,通过 `mmap` 拿 VRAM 映射,通过 `ioctl` 发起 kernel dispatch——就这样。

### file_operations:为什么不走 read / write

只实现了:

```c
open
release
mmap
unlocked_ioctl
```

故意不实现 `read / write`。GPU 数据传输不该走字符设备的字节流接口,而是直接把 BAR2(也就是 VRAM)映射到用户态地址空间。

所以用户态的 `gpuMemcpy()` 本质上就是:

```c
memcpy(ctx->vram_mmap + offset, host_ptr, size);  // H2D
memcpy(host_ptr, ctx->vram_mmap + offset, size);  // D2H
```

这种实现非常粗糙,但对 toy GPGPU 很合适:

- 不用先去实现 DMA engine
- 不用设计 copy command queue
- 调试时可以直接 D2H dump 任意 VRAM
- 软件栈路径非常清楚

`open()` 干的事也极少:从 inode 找到 `gpgpu_dev`,塞进 `file->private_data`。后续 `mmap()` 和 `ioctl()` 都从这里取设备上下文。

### mmap:把 BAR 映射给用户态

驱动 `mmap` 根据 `vm_pgoff` 决定映射哪个 BAR:

```text
vm_pgoff == 0  -> BAR0 控制寄存器
vm_pgoff == 1  -> BAR2 VRAM
```

用户态 `gpuInit()` 映射 VRAM 时用的:

```c
mmap(..., fd, 1 * PAGE_SIZE)
```

也就是让 `vm_pgoff == 1`,落到 BAR2。这里踩过一个坑:如果 offset 写成 0,会映射到 BAR0 控制寄存器,用户态以为自己在写 VRAM,实际是在写控制寄存器窗口——表现非常诡异,因为数据"写进去就丢了",但又不会立刻报错。

真正建立映射的是:

```c
io_remap_pfn_range()
```

把 PCI BAR 的物理页框映射到用户进程的虚拟地址空间。映射之后 `libgpgpu` 把 VRAM 当成普通内存读写就行。

### ioctl:一次 kernel launch 的控制路径

`ioctl` 当前只定义了一个核心命令 `GPGPU_IOC_DISPATCH`。用户态传:

```text
kernel_addr
kernel_args
grid_dim[3]
block_dim[3]
shared_mem_size
```

驱动收到后,把这些字段写进 BAR0 的 MMIO 控制寄存器:

```text
KERNEL_ADDR_LO / HI
KERNEL_ARGS_LO / HI
GRID_DIM_X/Y/Z
BLOCK_DIM_X/Y/Z
SHARED_MEM_SIZE
DISPATCH
```

最后写 `DISPATCH` 寄存器启动设备执行,然后驱动睡在 wait queue 上:

```c
wait_event_interruptible(wait_queue, kernel_done);
```

QEMU 侧的 kernel 跑完,通过 INTx 给 guest 一次中断。中断 handler 只做一件事:`kernel_done = 1`,唤醒等待队列。`ioctl` 返回,用户态认为这次 launch 完成。

整条路径压缩起来很像一次极简 CUDA launch:

```text
用户态准备 args
    ↓
ioctl 写 dispatch registers
    ↓
设备执行 kernel
    ↓
中断通知完成
    ↓
ioctl 返回
```

------

## 四、用户态 runtime:`libgpgpu`

驱动以上的所有东西都在 `libgpgpu` 里,用户态 C 代码。它要做的事大致是:管理 VRAM、加载 kernel binary、组织 kernel args、调 `ioctl` launch、提供给上层一个看起来像 GPU runtime 的接口。

### VRAM 分配:参考 Linux buddy + slab

`libgpgpu` 没有向驱动申请内存,也没有真正的 GPU page table——它管理的只是 `mmap` 出来的 BAR2 那一段 offset。

大块走 buddy allocator,思路完全按 Linux buddy 那套:

- VRAM 按 4KB page 管理
- 每个 order 对应 `2^order` 个 page
- 分配时找能装下请求的最小 order
- 没有合适大小就从更大的块二分,右半挂回低一级 free list
- 释放时找 buddy,如果 buddy 也空闲就合并

小块走 slab cache。当前有这几档 object size:

```text
32, 64, 128, 256, 512, 2048 bytes
```

每个 slab 从 buddy 拿一页,切成固定大小 slot,用链表管空闲 slot。这样 kernel args 这类 32 字节的小对象不用浪费整页。

这个 buddy 实现有一个非常真实的缺陷:**所有请求向上 round 到 2 的幂 order**。

举个例子:4GB VRAM,已经分掉一个接近 2GB 的大块,剩下空间被切成若干 buddy 块之后,如果再想要一块"略大于 1/4 VRAM"的连续大块,会失败——不是总容量不够,是连续 buddy block 不够。

这个问题在加载大模型权重时直接撞上了,后面 `weight_loader` 才会把权重拆成多个 region 而不是一次性申请一大块。所以当前 allocator 顶多算"能撑实验的 toy allocator",离成熟 GPU memory manager 还远。

### weight_loader:把 Qwen 权重搬进 VRAM

`weight_loader` 的职责非常单纯:把 host 文件系统里的权重二进制读出来,放到 VRAM 固定位置,并提供"某层某个 tensor 在 VRAM 哪里"的查询接口。

它**不做**:

- tokenizer
- safetensors 解析
- transpose
- dtype 转换
- lazy loading
- 运行时 shape 推导

这些事全部前移到 dump 权重的 Python 工具里。到 C 这一侧,权重已经被整理成一组固定二进制:

```text
embedding.bin
lm_head.bin
final_norm.bin
layer_00.bin
...
layer_23.bin
```

每个 `layer_NN.bin` 内部的 tensor offset 是固定的,定义在 `weight_layout.h`,包含 `input_norm` / `q_proj.w/b` / `k_proj.w/b` / `v_proj.w/b` / `o_proj.w` / `post_norm` / `gate_proj.w` / `up_proj.w` / `down_proj.w`。

这里一个关键约定:**所有 `\*_proj.weight` 已经提前转成 device `gemm.S` 能直接读的 `[K, N]` 布局**。GPU kernel 不做转置,`weight_loader` 也不做转置。

查询不走字符串,走 enum:

```c
weight_loader_layer(wl, 12, WL_DOWN_PROJ_W)
weight_loader_embedding(wl)
weight_loader_lm_head(wl)
weight_loader_final_norm(wl)
```

tensor 名写错会在编译期就暴露出来,不会等运行时拼字符串失败。

#### 为什么权重要拆成 8 个 region

最初的自然想法:把所有权重当成一个 2.35 GiB 大块,一次 `gpuMalloc()` 然后按 offset 排进去。

实际撞上了前面 buddy round-up 的问题:2.35 GiB 这种请求会被 round 到 4 GiB,直接把可用 VRAM 全占了。

最后改成 8 个 region:

```text
region[0] = embedding
region[1] = lm_head
region[2] = final_norm + layer 0..3
region[3] = layer 4..7
region[4] = layer 8..11
region[5] = layer 12..15
region[6] = layer 16..19
region[7] = layer 20..23
```

8 这个数字没有任何模型结构上的含义,纯粹是为了绕开 buddy 大块分配的碎片。每 4 层一组大约 228 MB,buddy round 到 256 MB,整体还能给 scratch、KV cache、kernel binaries、args buffer 留出余量。

副作用是调试更直观:打印 layout 能看到每个 region base 和每层 base。某一层算错,可以直接 D2H 对应 VRAM 区间,和 host 文件某个 offset 做 bit-exact 对照。

#### 权重加载最容易踩的坑

实际踩过一次非常典型的:VM 里的 `/root/weights/*.bin` 和 host 端 `weights/*.bin` 不一致。表现像是 layer 12 的 `down_proj` GEMM 算错,最后定位到是 VM 里 `layer_12.bin` 中间有一段全 0,文件本身坏了。

所以现在权重部署完之后第一件事就是 checksum gate,host 和 VM 两边 md5sum 对一遍。这种 gate 不做的话,后面的逐层 bit-exact 对照完全没意义——你不知道是算子错了还是输入错了。

------

## 五、GPU kernel:手写 RV32 汇编

`kernels/` 下每个 `.S` 都是一个 GPU kernel。不是 CUDA,不是 OpenCL,而是设备侧 SIMT 解释器能跑的一段 RV32 程序。

transformer 路径里最关键的几个:

- `embedding_lookup.S`:按 token id 取 embedding 行
- `rmsnorm.S`:RMSNorm,warp 内规约平方和
- `gemm.S`:矩阵乘法,q/k/v/o/ffn/lm_head 全靠它
- `broadcast_add.S`:加 bias 或 residual
- `rope.S`:Q/K 的 rotary position embedding
- `qkt_decode.S`:decode 阶段算 QK attention score
- `softmax_decode.S`:对当前 token 可见的 score 做 softmax
- `pv_decode.S`:用 attention probability 加权 V cache
- `silu.S`:FFN gate 的激活
- `vmul.S`:`silu(gate) * up`
- `argmax.S`:从 logits 里取 greedy token

参数传递没有走 C ABI,而是用户态把 args struct 写进 VRAM,kernel 从 `a0` 指向的 args buffer 里按固定 offset `lw` 出来。所以 C 这边 args struct 的字段顺序,必须和 `.S` 里 `lw` 的顺序严格一致。

这类 bug 极其隐蔽:**字段错位通常不 crash,只是某个 lane 拿到一个奇怪地址或奇怪 shape**。算子算出来的数对得上某个奇怪 pattern,但不是你期望的那个数。最后定位都得靠对照 `.dump` 反汇编一行一行核 offset。

------

## 六、KV cache:最朴素的一直追加

初始化时一次性分配 K/V 两个大 buffer:

```text
K: [num_layers, num_kv_heads, max_seq, head_dim]
V: [num_layers, num_kv_heads, max_seq, head_dim]
```

每生成一个 token,每层都会产生新的 K/V。当前流程是:

1. `SCRATCH_K` / `SCRATCH_V` 在 device 上算出当前层、当前 token 的 K/V
2. D2H 拷到 host 临时 buffer
3. host 调 `kv_cache_append_layer()` 把它写回 KV cache 对应位置
4. 一个 token 的 24 层都 append 完,`kv_cache_commit_token()` 推进 `filled`

它不会释放旧 token,不做 sliding window,就是从 position 0 一直追加到 `max_seq`。和 toy decode 匹配得很好,但性能很差:每层都有 K/V 的 D2H + H2D 往返。

后面要优化的话,该写一个 device-side `kv_cache_append` kernel,让 K/V 直接在 VRAM 内搬到 cache 位置,完全不下到 host。但这是 todo。

------

## 七、transformer:把一堆 kernel 串成 decode pipeline

`transformer.c` 不是个高级框架,就是把固定的 Qwen2-0.5B decode 计算图手动展开。当前只支持 `S_max = 1` 的纯 decode 路径。

一个 token 的完整流程:

```text
embedding
    ↓
for layer in 0..23:
    input rmsnorm
    q_proj / k_proj / v_proj
    q/k bias add
    q/k rope
    append K/V cache
    qkt_decode
    softmax_decode
    pv_decode
    o_proj
    residual add
    post rmsnorm
    gate_proj / up_proj
    silu
    vmul
    down_proj
    residual add
    ↓
final rmsnorm
lm_head
argmax
```

为了省显存,workspace 里只维护几块 scratch buffer:

```text
RESID_A / RESID_B
SCRATCH_X
SCRATCH_Q / SCRATCH_K / SCRATCH_V
SCRATCH_SCORES
SCRATCH_FFN_A / SCRATCH_FFN_B
LOGITS
```

这些 buffer 在不同算子之间反复复用。比如 `SCRATCH_X` 一会儿装 RMSNorm 输出,一会儿装 attention 输出,一会儿又是 down_proj 输出。代码可读性一般,但显存占用可控,而且很接近手写推理 engine 的真实状态——真实推理 engine 也是在显存大小约束下硬塞,不可能给每个中间张量单独留一块。

最后 toy 推理入口 `infer_tokens` 只做 greedy argmax,tokenizer / detokenizer 留在 host Python 侧,VM 内只处理 token id。这是为了先把"文本 → token → GPGPU 推理 → token → 文本"闭环跑通,而不是一开始就把 tokenizer 也塞进 C。

## 总结

回头看,这个项目最大的价值是把「一颗(虚拟的)显卡是怎么被软件使用的」这件事亲手走了一遍。
