# Rust 外设建模

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

Rust for QEMU 的目标是让 Rust 设备与现有 C 基础设施协同工作。本文聚焦“如何用 Rust 建模外设”，并以 I2C 设备与 GPIO 设备（PCF8574）作为示例，说明从构建接入到设备行为实现的完整链路，同时补充 SysBus 的 Rust 封装要点。

!!! tip "概览"

    - 建模链路：Kconfig/Meson/Cargo → 绑定生成 → QOM/Device
    - I2C 设备：总线与从设备接口的 Rust 封装
    - GPIO 设备：PCF8574 作为 I2C GPIO 扩展器
    - SysBus 封装：MMIO/IRQ 接入与 BQL 约束
    - 设备共存：Rust/C 双实现的选择与回退

## 建模流程

Rust 外设的建模流程可以抽象为三层：

```
Kconfig/Meson/Cargo
        |
   bindgen 绑定
        |
   Rust 设备实现
```

要点如下：

1. **构建接入**：在 Kconfig 提供 Rust 设备开关，Meson 里用 `rust.bindgen` 生成 `bindings.inc.rs`，再通过 `static_library` 与 `rust_devices_ss` 把 Rust 设备链接进 `qemu-system-*`。
2. **绑定生成**：`wrapper.h` 控制绑定范围，确保只暴露必要的 C API。
3. **设备实现**：用 `qom`/`hwcore` 等 crate 实现 QOM 与 Device trait，必要时补齐 VMState 与复位阶段。

Rust 设备通常与 C 设备并存，Rust 版本启用失败时仍可回退到 C 版本，这样更利于逐步迁移与验证。

## I2C 设备

在 qemu-rust 邮件列表的补丁中，I2C 设备的实现路径被拆分为两步：先补 I2C 总线与从设备的 Rust 封装，再实现具体设备（如 PCF8574）。典型结构包含：

- **I2C 总线对象**：提供 `init_bus` 等初始化接口，与 QOM 层对齐。
- **I2C 从设备接口**：提供 `send`/`recv` 与地址配置方法，将 C 侧 I2C 回调桥接到 Rust。

因此，I2C 设备的实现重点并不在“设备本身”，而是先建立 **Rust 的 I2C Bus/Slave 基础设施**，让后续设备复用这一层能力。

## GPIO 设备

PCF8574 是典型的 I2C GPIO 扩展器：通过 I2C 数据字节把 8 路 GPIO 的电平映射为位图。Rust 版本的实现通常包含：

- **内部寄存器/状态**：保存 I/O 方向、当前输出、电平快照。
- **I2C 写入路径**：更新输出寄存器并驱动 GPIO 输出。
- **I2C 读取路径**：根据当前输入状态返回位图。
- **中断源**：输入电平变化时触发 IRQ 线。

这种设备很好地展示了 Rust 设备与既有 GPIO/IRQ 基础设施的配合方式，也验证了 I2C Rust 封装的可用性。

## SysBus 封装

SysBus 是 QEMU 常见的板级外设接口。Rust 侧在 `rust/hw/core/src/sysbus.rs` 提供 `SysBusDevice` 封装，并通过 `SysBusDeviceMethods` 暴露关键能力：

- `init_mmio`：注册 MMIO 区域
- `init_irq`：注册 IRQ 输出
- `mmio_map`：把 MMIO 映射到 guest 地址
- `connect_irq`：连接中断线
- `sysbus_realize`：触发设备 realize

这些操作都需要在 BQL（Big QEMU Lock）持有时进行，以保证并发访问安全。

## 建模示意

```
Rust Device
   | QOM/DeviceImpl
   v
SysBus/I2C/GPIO wrappers
   |
bindings::C APIs
   |
QEMU core
```

## 本章小结

Rust 外设建模的关键在于：**先建立总线与基础封装，再实现具体设备**。I2C 与 GPIO 的示例表明，Rust 设备可以沿着 QOM/Device 接口接入 QEMU 运行时，依托 SysBus/I2C 等封装复用现有 C 基础设施。理解这些层级关系，才能在 Rust 侧稳定扩展外设模型。

!!! tip "进一步阅读"

    [RFC PATCH v3 0/4] rust/hw: Add the I2C and the first GPIO device
    https://yhbt.net/lore/qemu-rust/cover.1764426204.git.chenmiao@openatom.club/

    [RESEND RFC PATCH V3 4/4] rust/hw/gpio: Add the first gpio device pcf8574
    https://yhbt.net/lore/qemu-rust/20251129154321.iSfXzLmwQ-fwfqOPI61ZlM3hBigi55HQjOD_pCGRQN0@z/
