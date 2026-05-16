# QEMU 训练营 2026 专业阶段总结

!!! note "主要贡献者"

    - 作者：[@lingqian-gi](https://github.com/lingqian-gi)

---

## 背景介绍

我是一名电子相关专业的大三学生，想要往嵌入式linux方向发展，最近在学习设备树、linux驱动等内容，然后就接触到了qemu的概念。了解到刚好QEMU训练营2026开始，便报名参与，希望学到linux与外设建模之间的更多知识点，打算深入了解SOC相关的知识。

---

## 开发环境

| 项目 | 说明 |
|------|------|
| 主机 | Windows |
| 开发环境 | CNB 云原生开发环境 |
| AI 搭子 | Cursor / VS Code Remote |

### 云原生配置

为了方便，直接使用提供的CNB仓库。同时为了避免每次重启环境都要自己手动git clone仓库和编译qemu，故进行了如下的云原生配置。

在 `.cnb.yml` 的 `vscode` 配置中添加了 `stages` 字段，实现打开云原生开发环境后自动按顺序执行三个任务：

**修改文件：`.cnb.yml`**

```yaml
# .cnb.yml
# 在使用云原生开发环境时，指定docker环境的镜像
# 匹配所有分支名
"$":
  web_trigger_build:
    - services:
        - docker
      runner:
        cpus: 64
      stages:
        - name: build-and-push-image
          script: |
            IMAGE_TAG="${tag:-latest}"
            echo "使用镜像标签: ${IMAGE_TAG}"
            docker build -f ./.ide/Dockerfile -t ${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}:${IMAGE_TAG} .
            docker push ${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}:${IMAGE_TAG}
  vscode:
    - runner:
        cpus: 12
      docker:
        image: docker.cnb.cool/gevico.online/qemu-lab:latest
      services:
        - vscode
        - docker
      stages:
        - name: clone-qemu-camp-repo
          script: |
            if [ ! -d "qemu-camp-2026-exper-lingqian-gi" ]; then
              echo ">>> 开始克隆 qemu-camp-2026 仓库..."
              git clone https://github.com/gevico/qemu-camp-2026-exper-lingqian-gi
              echo ">>> 克隆完成"
            else
              echo ">>> 仓库已存在，跳过 clone"
            fi
        - name: configure-qemu
          script: |
            cd /workspace/qemu-camp-2026-exper-lingqian-gi && make -f Makefile.camp configure
        - name: build-qemu
          script: |
            cd /workspace/qemu-camp-2026-exper-lingqian-gi && make -f Makefile.camp build
```

**配置原理**

CNB 云原生开发环境中，`.cnb.yml` 的 `vscode` 事件支持 `stages` 字段。环境启动后，流水线会按顺序执行 stages 中定义的任务：

| Stage | 名称 | 执行内容 |
|-------|------|----------|
| 1 | clone-qemu-camp-repo | `git clone` 克隆仓库（幂等：已存在则跳过） |
| 2 | configure-qemu | `cd` 进入仓库 + `make -f Makefile.camp configure` |
| 3 | build-qemu | `cd` 进入仓库 + `make -f Makefile.camp build` |

---

## 专业阶段

通过学习专业阶段SOC方向，学习到了QEMU是如何模拟linux，并且如何进行不同的配置和修改设备，了解了MMIO、Kconfig的使用，对硬件虚拟化有了更深的了解。

### 一、MMIO（内存映射I/O）

在普通系统中，CPU 通过地址总线、数据总线和控制总线与内存和外设通信。MMIO 将一部分物理地址空间划分给外设，而不是全部给 RAM。

**示例地址分配：**

- 物理地址 0x80000000 – 0x9FFFFFFF 分配给 DDR 内存
- 物理地址 0x10000000 – 0x10000FFF 分配给 UART 控制器的寄存器
- 物理地址 0x10001000 – 0x10001FFF 分配给 GPIO 控制器

当 CPU 执行 `ld t0, 0x10000000`（RISC-V 示例）时，内存控制器或总线解码器检测到该地址落在 UART 范围内，于是将访问请求路由到 UART 设备，而不是真正的 RAM。

**MMIO 与端口 I/O 对比：**

| 对比项 | MMIO | 端口 I/O（如 x86 IN/OUT） |
|--------|------|---------------------------|
| 地址空间 | 与内存共享地址空间 | 独立的 I/O 地址空间(64KB) |
| 访问指令 | 普通访存指令（mov, ld, st） | 专用指令（in, out） |
| C 语言支持 | 指针解引用即可（需 volatile） | 需要内联汇编或编译器内置函数 |
| 地址范围 | 很大(受 CPU 地址总线宽度限制) | 很小(x86 上 16 位端口地址) |
| 设备数量 | 可挂载海量设备 | 最多 65536 个 8 位端口 |
| 典型平台 | ARM、RISC-V、MIPS、PowerPC 以及现代 x86(PCIe 配置空间) | 传统 x86(如 PC 的 COM 口、并口) |

> **注**：现代 x86 也大量使用 MMIO，例如 PCIe 设备的 BAR 空间，但仍保留 IN/OUT 指令用于兼容旧式设备。

---

### 二、QEMU 设备注册与 MMIO 实现

QEMU 使用一套灵活的面向对象设备模型（QOM），允许动态注册各种硬件设备。

#### 设备注册流程

1. **定义 TypeInfo 结构体**：指定设备名称、父类、实例大小、初始化函数等
2. **调用 type_init 注册**：将设备类型注册到 QEMU 的类型系统
3. **实现 class_init**：设置 realize、reset、vmsd 等方法
4. **实现 instance_init**（可选）：实例化时初始化成员变量

#### MMIO 实现关键步骤

在设备的 `realize` 函数中：

```c
static void mydevice_realize(DeviceState *dev, Error **errp)
{
    MyDeviceState *s = MYDEVICE(dev);
    
    // 1. 初始化 MemoryRegion，绑定读写回调
    memory_region_init_io(&s->mmio, OBJECT(dev),
                         &mydevice_ops, s,
                         "my-device", MYDEVICE_MMIO_SIZE);
    
    // 2. 将 MMIO 区域添加到 SysBus
    sysbus_init_mmio(SYS_BUS_DEVICE(dev), &s->mmio);
    
    // 3. 初始化中断线
    sysbus_init_irq(SYS_BUS_DEVICE(dev), &s->irq);
    
    // 4. 初始化其他资源（定时器、GPIO等）
    // ...
}
```

#### MemoryRegionOps 结构体

定义设备寄存器的读写回调函数和访问约束：

```c
static const MemoryRegionOps mydevice_ops = {
    .read = mydevice_read,
    .write = mydevice_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {
        .min_access_size = 4,
        .max_access_size = 4,
    },
    .impl = {
        .min_access_size = 4,
        .max_access_size = 4,
    },
};
```

---

### 三、中断处理

QEMU 使用 `qemu_irq` 来表示中断线。

#### 中断连接流程

1. **设备侧**：在 `realize` 中调用 `sysbus_init_irq` 创建中断输出线
2. **板级代码**：调用 `sysbus_connect_irq` 将设备的中断线连接到中断控制器（PLIC、GIC 等）
3. **触发中断**：设备逻辑中调用 `qemu_set_irq(s->irq, 1)` 触发中断，`qemu_set_irq(s->irq, 0)` 清除中断

#### 示例代码

```c
// 设备侧：触发中断
static void mydevice_write(void *opaque, hwaddr addr,
                           uint64_t value, unsigned size)
{
    MyDeviceState *s = opaque;
    
    switch (addr) {
    case REG_INTERRUPT_ENABLE:
        s->int_enable = value;
        break;
    case REG_INTERRUPT_SET:
        s->int_status |= value;
        if (s->int_status & s->int_enable) {
            qemu_set_irq(s->irq, 1);  // 触发中断
        }
        break;
    // ...
    }
}

// 板级代码：连接中断
void my_board_init(MachineState *machine)
{
    DeviceState *dev;
    DeviceState *plic;
    
    // 创建中断控制器
    plic = sysbus_create_simple("riscv.plic", VIRT_PLIC_BASE,
                                CPU_IRQ_LINE);
    
    // 创建设备
    dev = qdev_new(TYPE_MYDEVICE);
    sysbus_realize_and_unref(SYS_BUS_DEVICE(dev), &error_fatal);
    
    // 映射 MMIO 地址
    memory_region_add_subregion(get_system_memory(),
                                MYDEVICE_BASE,
                                sysbus_mmio_get_region(SYS_BUS_DEVICE(dev), 0));
    
    // 连接中断：设备 IRQ 0 -> PLIC 输入 N
    sysbus_connect_irq(SYS_BUS_DEVICE(dev), 0,
                       qdev_get_gpio_in(plic, MYDEVICE_PLIC_IRQ_NUM));
}
```

---

### 四、设备重置（Reset）回调

当系统复位（如软复位）时，QEMU 会调用设备的 reset 方法。

#### 注册重置回调

在 `class_init` 中设置：

```c
static void mydevice_class_init(ObjectClass *klass, void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    
    dc->realize = mydevice_realize;
    dc->reset = mydevice_reset;  // 设置重置回调
    dc->vmsd = &mydevice_vmstate;
    dc->desc = "My Device";
}
```

#### 实现重置函数

```c
static void mydevice_reset(DeviceState *dev)
{
    MyDeviceState *s = MYDEVICE(dev);
    
    // 恢复所有寄存器到默认值
    s->data = 0;
    s->status = 0x01;      // 默认状态
    s->control = 0;
    s->int_enable = 0;
    s->int_status = 0;
    
    // 停止定时器
    qemu_set_irq(s->irq, 0);
    timer_del(&s->timer);
    
    // 其他清理工作
    // ...
}
```

---

### 五、状态保存与恢复（VMStateDescription）

`VMStateDescription` 用于实现设备状态的迁移（快照、保存/恢复）。

#### 定义 VMState

```c
static const VMStateDescription mydevice_vmstate = {
    .name = "my-device",
    .version_id = 1,
    .minimum_version_id = 1,
    .fields = (VMStateField[]) {
        VMSTATE_UINT32(data, MyDeviceState),
        VMSTATE_UINT32(status, MyDeviceState),
        VMSTATE_UINT32(control, MyDeviceState),
        VMSTATE_UINT32(int_enable, MyDeviceState),
        VMSTATE_UINT32(int_status, MyDeviceState),
        VMSTATE_TIMER(timer, MyDeviceState),
        VMSTATE_END_OF_LIST()
    }
};
```

#### 注册 VMState

在 `class_init` 中设置：

```c
dc->vmsd = &mydevice_vmstate;
```

> **说明**：QEMU 在保存状态时会遍历这些字段，写入到镜像文件；恢复时自动填充设备结构体。支持版本管理、数组、指针、定时器等复杂类型。

---

### 六、MMIO 如何被 CPU 访问？—— 地址路由

当 CPU 执行 ld/st 指令访问某个物理地址时，QEMU 的内存 API 会根据地址找到对应的 `MemoryRegion`。

#### 地址映射流程

1. **板级代码**调用 `memory_region_add_subregion` 将设备的 MMIO 区域映射到系统地址空间：

```c
// 在板级初始化函数中
memory_region_add_subregion(get_system_memory(),
                            MYDEVICE_BASE_ADDR,
                            &s->mmio);
```

2. **CPU 访问**落在该 MemoryRegion 范围内时，QEMU 调用 `mydevice_ops.read / .write`，并将结果返回给 CPU 模型。

3. 如果访问宽度不符合 `impl` 的限制，QEMU 会进行拆分或调用 `access_with_adjusted_size` 辅助函数，确保每个分片都符合设备要求。

---

### 七、完整流程图

```
QEMU 启动
    │
    ├─ type_init(mydevice_register_types)
    │       └─ 注册 TypeInfo 到全局类型系统
    │
    ├─ 设备实例化 (命令行或板级代码)
    │       ├─ object_new(TYPE_MYDEVICE) → 分配 MyDeviceState
    │       ├─ 调用 instance_init (若有)
    │       ├─ 设置属性 (如可通过 -device 传递)
    │       └─ realize 设备
    │               ├─ 调用 mydevice_realize
    │               │     ├─ memory_region_init_io → 绑定 MemoryRegionOps
    │               │     ├─ sysbus_init_mmio → 将 MR 添加到设备的 MMIO 列表
    │               │     ├─ sysbus_init_irq → 创建中断线
    │               │     └─ 其他初始化
    │               └─ 板级代码映射 MMIO 到系统地址空间
    │
    ├─ CPU 访问 MMIO 地址
    │       ├─ 内存子系统路由 → mydevice_ops.read/write
    │       └─ 回调函数更新设备状态 / 触发中断
    │
    ├─ VM 保存/恢复
    │       └─ 通过 mydevice_vmstate 自动序列化
    │
    └─ 系统复位
            └─ 调用 mydevice_reset 恢复初始状态
```

---

## 调试手段

### 使用 GDB 调试 QEMU

可以用 gdb 来对某个测试用例进行断点调试：

```bash
QTEST_QEMU_BINARY="gdb --args ./qemu-system-riscv64" \
    ./tests/gevico/qtest/test-flash-read
```

然后在 gdb 中设置断点并运行：

```gdb
(gdb) break mydevice_write
(gdb) run
```

### 使用 QTest 进行设备测试

QEMU 提供 QTest 框架用于测试设备模型。通过向设备的 MMIO 区域读写数据，验证设备行为是否符合预期。

**示例测试代码：**

```c
static void test_mydevice(void)
{
    QTestState *qts;
    uint32_t value;
    
    // 启动 QEMU 并连接 QTest
    qts = qtest_init("-machine my-board -device my-device");
    
    // 写入寄存器
    qtest_writel(qts, MYDEVICE_BASE + REG_CONTROL, 0x01);
    
    // 读取寄存器
    value = qtest_readl(qts, MYDEVICE_BASE + REG_STATUS);
    g_assert_cmpuint(value, ==, 0x01);
    
    // 清理
    qtest_quit(qts);
}
```

---

## 实验中遇到的问题

### 问题一：云原生环境重启后环境丢失

**问题描述**：每次重启 CNB 云原生开发环境后，之前克隆的仓库和编译结果都会丢失。

**解决方案**：在 `.cnb.yml` 中配置 `stages`，实现环境启动时自动克隆仓库、配置和编译 QEMU（如本文档"开发环境"章节所示）。

### 问题二：MMIO 访问宽度不匹配

**问题描述**：在编写设备模型时，如果 CPU 访问的宽度与设备 `MemoryRegionOps.impl` 定义的宽度不匹配，可能导致访问被拆分或失败。

**解决方案**：
- 在 `MemoryRegionOps.valid` 中定义设备**支持**的访问宽度范围
- 在 `MemoryRegionOps.impl` 中定义设备**实现**的访问宽度
- QEMU 会自动处理访问拆分，但需要注意回调函数中正确处理不同宽度的访问

### 问题三：中断触发时机不正确

**问题描述**：设备触发中断的时机不正确，导致操作系统驱动无法正确响应。

**解决方案**：
- 仔细阅读硬件手册，确认中断触发条件（边沿触发/电平触发）
- 在设备状态变化时正确设置/清除中断状态寄存器
- 确保中断使能寄存器正确控制哪些中断可以被触发
- 使用 `qemu_set_irq(s->irq, 1)` 触发中断，`qemu_set_irq(s->irq, 0)` 清除中断

---

## 总结

通过学习专业阶段 SOC 方向，学习到了 QEMU 是如何模拟 linux，并且如何进行不同的配置和修改设备，了解了 MMIO、Kconfig 的使用，对硬件虚拟化有了更深的了解。

主要收获：

1. **理解了 QOM（QEMU Object Model）的设备模型**：从类型注册、实例化、realize 到 reset 和 vmstate，形成了完整的设备生命周期理解。

2. **掌握了 MMIO 的实现原理**：通过 `MemoryRegion` 和 `MemoryRegionOps` 实现设备寄存器的模拟，理解 CPU 访问如何路由到设备回调函数。

3. **理解了中断处理机制**：通过 `qemu_irq` 连接设备与中断控制器，掌握中断触发和清除的正确方法。

4. **学会了设备状态的保存与恢复**：通过 `VMStateDescription` 实现设备状态的可迁移性，支持快照和实时迁移。

5. **掌握了调试手段**：使用 GDB 和 QTest 框架对设备模型进行调试和测试。

接下来进项目阶段，会带着这套建模与调试习惯，少在脚手架里打转，多在需求与验证闭环里迭代；同时也希望能在项目阶段学习到更多知识，深入实践 SOC 建模和 Linux 驱动之间的交互。

---

## 参考资料

- [QEMU 官方文档](https://www.qemu.org/docs/master/)
- [QEMU 源代码](https://github.com/qemu/qemu)
- [RISC-V 规范](https://riscv.org/technical/specifications/)
- HPC Wiki - [CUDA 编程入门](https://hpcwiki.io/gpu/cuda/)
