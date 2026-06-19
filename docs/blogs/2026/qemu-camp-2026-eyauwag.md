# QEMU 训练营 2026 专业阶段总结

## 背景介绍
工作当中偶尔用到QEMU,一直都觉得它非常强大和神秘。这次有机会近距离去看这个项目，并能动手添加一些代码，内心是非常激动的。由于第一次接触QEMU源代码，对他的架构还是挺陌生的，尤其是选择了新的语言RUST，更加非常惶恐。但是好在有AI的加持，一边学习，一边添加代码，终于跑通了测试，内心很激动。

## 专业阶段
测试内容主要是跑通I2C BUS的单元测试以及QEMU QTEST的集成测试。I2C BUS的单元测试只需要完成I2CBUS的函数，能够实现I2C BUS的逻辑即可，对于我来说难度不算太大。但是对于QTEST的集成测试，却是难度挺大的。我面对的挑战包括：
- 什么是QTEST
- g233.c实现了什么功能
- 模块是怎么集成到系统里面去的
- RUST与C语言代码是怎么合作的
- QOM是什么？RUST语言如何基于QOM建模，将I2C模型和SPI模型加入到QEMU的框架里面去
我记录了自己学习的过程，按“如何接入编译系统 -> QOM 建模 -> Rust 侧 QOM 实现 -> 从 g233 建机到 I2C/SPI 寄存器读写”的顺序，梳理完整路径。

### 1. 整体架构一图

```mermaid
flowchart LR
  A[configure --enable-rust] --> B[Meson have_rust]
  B --> C[Kconfig 打开 GEVICO_G233]
  C --> D[select I2C_GPIO/SPI_GPIO]
  D --> E[C 侧 QOM 壳: i2c-gpio/spi-gpio]
  E --> F[Rust 后端: rust/hw/gevico/src/lib.rs]
  F --> G[g233.c qdev_new + mmio_map]
  G --> H[Guest/QTest 读写 MMIO 寄存器]
  H --> I[I2CBus + AT24C02 / SPI Flash 状态机]
```

### 2. 新设备模型如何接入编译系统

#### 2.1 Rust 总开关

1. `configure` 支持 `--enable-rust` 和 `--disable-rust`，并支持 `--rust-target-triple`。
2. `meson.build` 通过 `have_rust = add_languages('rust', ...)` 启用 Rust，并检查 `rustc >= 1.83.0` 和 `bindgen >= 0.60.0`。
3. 成功后会在配置头里设置 `CONFIG_HAVE_RUST`，后续 Kconfig 可用 `depends on HAVE_RUST`。

关键位置：
- `configure`
- `meson.build`

#### 2.2 Kconfig 依赖链

1. `GEVICO_G233` 在 `hw/riscv/Kconfig` 里 `select I2C_GPIO`、`select SPI_GPIO`。
2. `I2C_GPIO` 在 `hw/i2c/Kconfig` 里：
   - `depends on HAVE_RUST`
   - `select I2C`
   - `select AT24C`
   - `select X_I2C_RUST`
3. `SPI_GPIO` 在 `hw/ssi/Kconfig` 里：
   - `depends on HAVE_RUST`
   - `select SSI`
   - 当前代码为 `select X_I2C_RUST`（即 SPI 也复用同一个 Rust crate 开关）

关键位置：
- `hw/riscv/Kconfig`
- `hw/i2c/Kconfig`
- `hw/ssi/Kconfig`

#### 2.3 Rust crate 注入链接

1. `rust/hw/gevico/meson.build` 构建静态 Rust 库 `gevico_i2c_gpio`（其中同时包含 I2C 与 SPI Rust 逻辑）。
2. 该库通过 `rust_devices_ss.add(when: 'CONFIG_X_I2C_RUST', ...)` 注入目标链接集合。
3. 顶层 `meson.build` 会收集 `rust_devices_ss` 的 crate 名，生成 `rust_<target>.rs` 根文件并链接进 `qemu-system-riscv64`。

关键位置：
- `rust/hw/gevico/meson.build`
- `meson.build`

### 3. QOM 模型如何落地

这里分两层：
- C 层：QOM 壳，负责类型注册和 MMIO 桥接。
- Rust 层：设备行为与状态机实现。

#### 3.1 C 层 QOM 壳（i2c-gpio / spi-gpio）

I2C 与 SPI 都采用同样模式：

1. 定义 QOM 类型名
   - `TYPE_I2C_GPIO = "i2c-gpio"`
   - `TYPE_SPI_GPIO = "spi-gpio"`
2. `OBJECT_DECLARE_SIMPLE_TYPE(...)` 声明对象类型。
3. `TypeInfo` 指定 `.parent = TYPE_SYS_BUS_DEVICE`。
4. `type_init(...)` 调用 `type_register_static(...)` 完成注册。
5. `realize` 阶段调用 Rust FFI 创建后端状态：
   - `i2c_gpio_rust_new`
   - `spi_gpio_rust_new`
6. `MemoryRegionOps.read/write` 直接转发给 Rust：
   - `*_rust_read`
   - `*_rust_write`
7. reset/finalize 也转发给 Rust：
   - `*_rust_reset`
   - `*_rust_free`

关键位置：
- `hw/i2c/i2c-gpio.c`
- `hw/ssi/spi-gpio.c`

#### 3.2 Rust 侧 QOM 实现（I2C）

I2C 设备是完整 Rust QOM 对象：

1. 结构体定义：
   - `#[derive(qom::Object, hwcore::Device)]`
   - 首字段 `parent_obj: ParentField<SysBusDevice>`
2. 类型声明：
   - `unsafe impl ObjectType for I2CGpioState { TYPE_NAME = c"i2c-gpio" }`
3. 继承关系：
   - `qom_isa!(I2CGpioState : SysBusDevice, DeviceState, Object)`
4. 生命周期钩子：
   - `impl ObjectImpl` 中设置 `INSTANCE_INIT`、`INSTANCE_POST_INIT`、`CLASS_INIT`
5. 设备接口：
   - `impl DeviceImpl`
   - `impl ResettablePhasesImpl`（实现 `HOLD`）
   - `impl SysBusDeviceImpl`
6. MMIO：
   - `MemoryRegionOpsBuilder` 绑定 `read/write` 到 Rust 成员函数

关键位置：
- `rust/hw/gevico/src/lib.rs`

#### 3.3 Rust QOM 框架原理（通用）

`rust/qom` 框架负责把 Rust 类型映射为 QOM `TypeInfo`：

1. `ObjectImpl` trait 提供 `TYPE_INFO` 常量。
2. `TYPE_INFO` 自动填充：
   - `name/parent`
   - `instance_init/instance_post_init/finalize`
   - `class_init`
3. `rust_instance_init`、`rust_class_init` 等 C ABI 函数作为桥接入口。

关键位置：
- `rust/qom/src/qom.rs`

### 4. 从建立 g233 到设备生效

#### 4.1 g233 机器创建并挂载设备

在 `g233.c` 里：

1. 内存映射定义：
   - I2C: `0x10013000`
   - SPI: `0x10019000`
2. 机器初始化时：
   - `qdev_new("i2c-gpio")` + `sysbus_realize_and_unref`
   - `sysbus_mmio_map(..., VIRT_I2C0.base)`
   - `qdev_new("spi-gpio")` + `sysbus_mmio_map(..., VIRT_SPI0.base)`

关键位置：
- `hw/riscv/g233.c`

#### 4.2 设备树（FDT）节点导出

`g233.c` 还会创建 FDT 节点：

1. `/soc/i2c@10013000`
   - compatible: `gevico,i2c-gpio`
2. `/soc/spi@10019000`
   - compatible: `gevico,spi-gpio`

关键位置：
- `hw/riscv/g233.c`

### 5. I2C 链路：从总线驱动到 EEPROM 读写

#### 5.1 I2C 控制器寄存器语义

Rust I2C 设备实现了寄存器：

1. `CTRL(0x00)`：`EN/START/STOP/RW`
2. `STATUS(0x04)`：`BUSY/ACK/DONE`
3. `ADDR(0x08)`：7-bit 地址
4. `DATA(0x0C)`：数据字节
5. `PRESCALE(0x10)`：分频

#### 5.2 总线与从设备模型

1. 总线：`I2CBus`（`rust/hw/i2c/src/lib.rs`）
   - `start_transfer`
   - `send`
   - `recv`
   - `end_transfer`
2. 从设备：`At24c02`（在 `rust/hw/gevico/src/lib.rs`）
   - 256 字节存储
   - 页大小 8 字节
   - 首字节作为 EEPROM 内部地址指针

#### 5.3 I2C 写流程（主机到从机）

1. 客户端写 `ADDR = 0x50`
2. 写 `CTRL = EN|START`，触发 `I2CBus::start_transfer(addr, false)`
3. 写 `DATA = mem_addr`，再写 `CTRL = EN`，触发 `send(mem_addr)`
4. 写 `DATA = payload`，再写 `CTRL = EN`，触发 `send(payload)`
5. 写 `CTRL = EN|STOP`，触发 `end_transfer`

状态位由 `set_done_ack` 更新：`DONE` 必置，`ACK` 取决于从机响应。

#### 5.4 I2C 读流程（含 repeated START）

1. `START+write` 先写入 EEPROM 内部地址
2. `START+read`（`RW=1`）重新寻址
3. `CTRL = EN|RW` 触发 `recv()`，返回到 `DATA`
4. `STOP` 结束传输

### 6. SPI 链路：寄存器到 Flash 状态机

SPI 在当前实现中是“C QOM 壳 + Rust FFI 状态机”：

1. C 层 MMIO 转发到 Rust：`spi_gpio_rust_read/write`
2. Rust 侧 `SPIGpioRust` 维护寄存器与 flash：
   - `CR1/SR/DR/CS`
   - `wel/wip`
   - `flash[256]`
3. 命令状态机：
   - `WREN(0x06)`
   - `RDSR(0x05)`
   - `READ(0x03)`
   - `WRITE(0x02)`

关键位置：
- `hw/ssi/spi-gpio.c`
- `rust/hw/gevico/src/lib.rs`

### 7. QTest 如何覆盖“寄存器读写 -> 总线事务”

#### 7.1 已有 I2C 用例

1. 寄存器复位与配置：
   - `test-i2c-gpio-init.c`
2. 位级流程（START/STOP/ACK）：
   - `test-i2c-gpio-bitbang.c`
3. EEPROM 读写与顺序读：
   - `test-i2c-eeprom-rw.c`
4. 页边界行为：
   - `test-i2c-eeprom-page.c`

#### 7.2 已有 SPI 用例

1. 寄存器初始化：
   - `test-spi-rust-init.c`
2. 传输流程：
   - `test-spi-rust-transfer.c`
3. Flash 命令与读写：
   - `test-spi-rust-flash.c`

#### 7.3 测试如何启动 g233

这些测试都通过类似入口启动：

```c
QTestState *qts = qtest_init("-machine g233 -m 2G");
```

即先创建 g233 机器，再直接通过 MMIO 地址读写控制器寄存器，完成端到端验证。

关键位置：
- `tests/gevico/qtest/*.c`

### 8. 新增同类 Rust 设备的推荐模板

新增一个“Rust 后端 + C QOM 壳”的设备，可按下面最小闭环：

1. Kconfig
   - 新增 `config XXX`
   - `depends on HAVE_RUST`
   - `select X_..._RUST`
2. C 壳
   - 定义 `TYPE_XXX`
   - `TypeInfo + type_init`
   - `MemoryRegionOps` 转发 Rust FFI
3. Rust crate
   - 导出 `xxx_rust_new/free/reset/read/write`
   - 如需完整 QOM 能力，按 `I2CGpioState` 模式实现 `ObjectImpl/DeviceImpl`
4. 机器接线
   - `qdev_new("xxx")`
   - `sysbus_realize_and_unref`
   - `sysbus_mmio_map`
   - `create_fdt_xxx`
5. qtest
   - 至少覆盖：reset 值、寄存器读写、关键协议流程、异常路径

### 9. 当前实现的一个注意点

`SPI_GPIO` 在 `hw/ssi/Kconfig` 中当前选择的是 `X_I2C_RUST`，说明 I2C/SPI Rust 逻辑共同放在 `rust/hw/gevico` crate 里由同一个配置开关驱动。后续如果希望 SPI 独立开关，可以改为单独 `X_SPI_RUST` 并拆分 crate。

## 总结
QEMU还是挺复杂的，QOM的引入使代码结构变简单了，但是需要一些额外的学习成本。以后还是要多学习它的一些底层架构。