本文档是专业阶段 SoC 方向的实验手册。

SoC 方向的核心任务：参照 [G233 SoC 硬件手册][5] 中的寄存器定义和编程模型，为 G233 虚拟开发板实现板卡实例化、GPIO/PWM/WDT 外设建模、SPI 控制器与 Flash 存储器件互联。

!!! note "提示"

    硬件建模部分也可以用 Rust 来写（QEMU 已有基本的 Rust 设备框架）。

## 环境搭建

第一步，安装 QEMU 开发依赖。

```bash
# Ubuntu 24.04
sudo sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/ubuntu.sources
sudo apt-get update
sudo apt-get build-dep -y qemu

# 安装 Rust 工具链（版本要求 >= 1.85）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"
cargo install bindgen-cli
```

!!! note "提示"

    SoC 方向使用 QTest 测试框架，测题在宿主机侧编译运行，**不需要** RISC-V 交叉编译工具链。

    安装 QEMU 开发环境，请参考导学阶段的 [Step0: 搭建 QEMU 开发环境][1]。

第二步，点击 [GitHub Classroom 邀请链接][3] 加入实验，系统会自动在组织下为你创建专属仓库并赋予 maintainer 权限。

!!! warning "注意"

    请通过上方链接获取仓库，**不支持手动 fork**。

第三步，clone 仓库到本地：

```bash
git clone git@github.com:gevico/qemu-camp-2026-exper-<你的 github 用户名>.git
```

第四步，添加上游远程仓库，用于同步上游代码变更：

```bash
git remote add upstream git@github.com:gevico/gevico-classroom-qemu-camp-2026-exper-qemu-camp-2026-exper.git
git pull upstream main --rebase
```

!!! note "提示"

    使用 SSH 地址需要在 GitHub 上配置 SSH Key，请参考 [GitHub SSH Key 配置指南](https://docs.github.com/zh/authentication/connecting-to-github-with-ssh)。

第五步，配置并编译：

```bash
make -f Makefile.camp configure
make -f Makefile.camp build
```

## 提交代码

所有实验的测题源码，均放在仓库根目录路径： `tests/gevico/qtest/` 。

SoC 方向使用 QEMU 的 **QTest 测试框架**——测题在宿主机侧编译运行，通过 QTest 协议直接读写 MMIO 寄存器（`qtest_readl` / `qtest_writel`）来检查设备行为，不需要写客户机程序。

先通读测题源码，搞清楚每道题在测什么，然后去 QEMU 本体里实现对应的设备模型（不要改测题源码）。文末有每道题的简介，帮你快速定位。

实现完成后，提交代码到你的仓库：

```bash
git add .
git commit -m "feat: subject..."
git push origin main
```

!!! note

    请确保你的代码符合仓库的代码规范，包括代码格式、注释等。

## 测评验收

本地运行全部测题的方式：

```bash
make -f Makefile.camp test-soc
```

SoC 方向全部测题通过的情况下，你会看到如下输出：

```bash
  TEST    qtest-riscv64/test-board-g233           1/10
  TEST    qtest-riscv64/test-gpio-basic           2/10
  TEST    qtest-riscv64/test-gpio-int             3/10
  TEST    qtest-riscv64/test-pwm-basic            4/10
  TEST    qtest-riscv64/test-wdt-timeout          5/10
  TEST    qtest-riscv64/test-spi-jedec            6/10
  TEST    qtest-riscv64/test-flash-read           7/10
  TEST    qtest-riscv64/test-flash-read-int       8/10
  TEST    qtest-riscv64/test-spi-cs               9/10
  TEST    qtest-riscv64/test-spi-overrun         10/10
```

如果你想运行某个测例，比如 `test-board-g233`，可以使用如下命令：

```bash
make -C build/tests/gevico/qtest/  run-board-g233
```

!!! note

    当你使用 `make -C` 指定了路径以后，你可以通过输入 `run-` 和 tab 键来查看可以运行的测题

如果你想调试某个测例的设备模型，可以使用 GDB 附加到 QTest 启动的 QEMU 进程。先在一个终端启动测例并暂停：

```bash
make -C build/tests/gevico/qtest/ gdbstub-board-g233
```

同理，你也可以通过 `gdbstub-` 和 tab 键来查看可以调试的测例。

然后在另一个终端使用 GDB 连接：

```bash
gdb -ex "target remote :1234" build/qemu-system-riscv64
```

!!! note

    建议对照 [G233 SoC 硬件手册][5] 和测题源码一起看，理解测试意图后再动手，调试效率会高很多。

每道测题 10 分，一共 10 道测题，共计 100 分，评分将显示到训练营的[专业阶段排行榜][4]。

## 实验介绍

实验覆盖：板卡实例化、GPIO 输入输出与中断、PWM 波形输出、WDT 看门狗超时、SPI 控制器与 Flash 读写。地址映射和寄存器定义见 [G233 SoC 硬件手册][5]。

测题在 `tests/gevico/qtest/` 目录下，文件名以 `test-` 开头。

### 实验一 test-board-g233

| 项目 | 内容 |
| --- | --- |
| 源码路径 | `tests/gevico/qtest/test-board-g233.c` |
| 功能描述 | 验证 G233 Board 基本工作，包括 CPU 启动、内存映射、MMIO 总线连通性 |
| 基础代码 | `hw/riscv/g233.c`（需补全） |
| 详细规格 | [G233 SoC 硬件手册][5] §3-§5 |

### 实验二 test-gpio-basic

| 项目 | 内容 |
| --- | --- |
| 源码路径 | `tests/gevico/qtest/test-gpio-basic.c` |
| 外设 | GPIO 控制器（`0x1001_2000`） |
| 功能描述 | 验证 GPIO 方向配置、输出控制和输入读取 |
| 详细规格 | [G233 SoC 硬件手册][5] §7 |

| 测试用例 | 测试内容 |
| --- | --- |
| `test_gpio_direction` | 设置 `GPIO_DIR` 为输出模式，验证寄存器读回正确 |
| `test_gpio_output` | 写 `GPIO_OUT` 输出高/低电平，通过 `GPIO_IN` 回读验证（输出模式下读回锁存值） |
| `test_gpio_multi_pin` | 同时操作多个引脚（bit 0, 7, 15, 31），验证独立性 |
| `test_gpio_reset_value` | 验证所有 GPIO 寄存器的复位默认值 |

### 实验三 test-gpio-int

| 项目 | 内容 |
| --- | --- |
| 源码路径 | `tests/gevico/qtest/test-gpio-int.c` |
| 外设 | GPIO 控制器（`0x1001_2000`），PLIC IRQ 2 |
| 功能描述 | 验证 GPIO 中断功能：触发类型、极性配置、中断状态清除 |
| 详细规格 | [G233 SoC 硬件手册][5] §7.3.4-§7.3.7 |

| 测试用例 | 测试内容 |
| --- | --- |
| `test_gpio_edge_rising` | 配置边沿触发 + 上升沿极性，模拟引脚跳变，验证 `GPIO_IS` 置位 |
| `test_gpio_level_high` | 配置电平触发 + 高电平极性，验证中断状态持续有效 |
| `test_gpio_is_clear` | 向 `GPIO_IS` 写 `1` 清除中断标志，验证清除成功 |
| `test_gpio_ie_mask` | 禁用 `GPIO_IE` 后，验证引脚变化不产生中断 |
| `test_gpio_plic` | 验证 GPIO 中断正确汇聚到 PLIC IRQ 2 |

### 实验四 test-pwm-basic

| 项目 | 内容 |
| --- | --- |
| 源码路径 | `tests/gevico/qtest/test-pwm-basic.c` |
| 外设 | PWM 控制器（`0x1001_5000`），4 通道 |
| 功能描述 | 验证 PWM 通道配置、周期/占空比设定、计数器运行和周期完成标志 |
| 详细规格 | [G233 SoC 硬件手册][5] §8 |

| 测试用例 | 测试内容 |
| --- | --- |
| `test_pwm_config` | 配置 CH0 的 `PERIOD=1000`, `DUTY=500`，验证寄存器读回正确 |
| `test_pwm_enable` | 置位 `PWM_CH0_CTRL.EN`，验证 `PWM_GLB.CH0_EN` 镜像位同步 |
| `test_pwm_counter` | 启动 CH0 后读取 `PWM_CH0_CNT`，验证计数器在递增 |
| `test_pwm_done_flag` | 等待计数器完成一个周期，验证 `PWM_GLB.CH0_DONE` 置位 |
| `test_pwm_done_clear` | 向 `PWM_GLB.CH0_DONE` 写 `1` 清除，验证标志复位 |
| `test_pwm_multi_channel` | 同时配置 CH0-CH3 不同周期/占空比，验证通道独立性 |
| `test_pwm_polarity` | 设置 `POL=1` 反相输出，验证极性配置生效 |

### 实验五 test-wdt-timeout

| 项目 | 内容 |
| --- | --- |
| 源码路径 | `tests/gevico/qtest/test-wdt-timeout.c` |
| 外设 | 看门狗定时器（`0x1001_0000`），PLIC IRQ 4 |
| 功能描述 | 验证 WDT 倒计时、喂狗、超时标志、锁定机制 |
| 详细规格 | [G233 SoC 硬件手册][5] §6 |

| 测试用例 | 测试内容 |
| --- | --- |
| `test_wdt_config` | 配置 `WDT_LOAD=0x100`, `WDT_CTRL.EN=1`，验证寄存器读回正确 |
| `test_wdt_countdown` | 启动 WDT 后读取 `WDT_VAL`，验证值在递减 |
| `test_wdt_feed` | 向 `WDT_KEY` 写入 `0x5A5A_5A5A` 喂狗，验证计数器重载为 `WDT_LOAD` 值 |
| `test_wdt_timeout_flag` | 不喂狗等待超时，验证 `WDT_SR.TIMEOUT` 置位 |
| `test_wdt_timeout_clear` | 向 `WDT_SR.TIMEOUT` 写 `1` 清除标志，验证清除成功 |
| `test_wdt_lock` | 向 `WDT_KEY` 写入 `0x1ACC_E551` 锁定，验证 `WDT_CTRL` 变为只读 |
| `test_wdt_interrupt` | 配置 `INTEN=1`，等待超时，验证中断到达 PLIC IRQ 4 |

### 实验六 test-spi-jedec

| 项目 | 内容 |
| --- | --- |
| 源码路径 | `tests/gevico/qtest/test-spi-jedec.c` |
| 外设 | SPI 控制器（`0x1001_8000`）+ W25X16 Flash (CS0) |
| 功能描述 | 验证 SPI 基本初始化、数据传输和 JEDEC ID 读取 |
| 详细规格 | [G233 SoC 硬件手册][5] §9, §10 |

| 测试用例 | 测试内容 |
| --- | --- |
| `spi_init` | 配置 SPI 主模式 + 使能，验证 `SPI_CR1` 寄存器正确 |
| `test_jedec_id` | 发送 `0x9F` 命令，读取 3 字节，验证返回 `0xEF 0x30 0x15` |
| `spi_transfer_byte` | 测试单字节收发，验证 `TXE` 和 `RXNE` 状态位 |

### 实验七 test-flash-read

| 项目 | 内容 |
| --- | --- |
| 源码路径 | `tests/gevico/qtest/test-flash-read.c` |
| 外设 | SPI 控制器 + W25X16 Flash (CS0) |
| 功能描述 | 验证 SPI Flash 完整读写流程（擦除→编程→读取→比对） |
| 详细规格 | [G233 SoC 硬件手册][5] §9, §10 |

| 测试用例 | 测试内容 |
| --- | --- |
| `flash_read_status` / `flash_wait_busy` | 读取 Flash 状态寄存器，轮询 BUSY 位等待操作完成 |
| `flash_sector_erase` | 发送 `0x20` + 3 字节地址，擦除 4 KB 扇区 |
| `flash_page_program` | 发送 `0x02` + 3 字节地址 + 256 字节数据，执行页编程 |
| `flash_read_data` | 发送 `0x03` + 3 字节地址，读取 256 字节并验证完整性 |
| `flash_write_test_data` | 完整擦除→编程→读取流程，比较全部 256 字节数据匹配 |

### 实验八 test-flash-read-int

| 项目 | 内容 |
| --- | --- |
| 源码路径 | `tests/gevico/qtest/test-flash-read-interrupt.c` |
| 外设 | SPI 控制器（PLIC IRQ 5）+ W25X16 Flash (CS0) |
| 功能描述 | 验证 SPI 中断驱动传输：TXE/RXNE/错误中断处理 |
| 详细规格 | [G233 SoC 硬件手册][5] §9.3.2, §9.3.3 |

| 测试用例 | 测试内容 |
| --- | --- |
| `spi0_interrupt_handler` | 处理 TXE/RXNE/错误中断，管理中断状态和计数 |
| `g233_spi_transfer_interrupt` | 中断方式收发数据，管理发送/接收缓冲区，支持超时检测 |
| Flash 中断操作 | 中断驱动的状态读取、JEDEC ID 读取、扇区擦除、页编程、数据读取 |
| `flash_write_test_data` | 中断方式完整 Flash 操作，比较数据完整性 |

### 实验九 test-spi-cs

| 项目 | 内容 |
| --- | --- |
| 源码路径 | `tests/gevico/qtest/test-spi-cs.c` |
| 外设 | SPI 控制器 + W25X16 (CS0, 2MB) + W25X32 (CS1, 4MB) |
| 功能描述 | 验证双 Flash 片选控制、独立操作和交叉操作 |
| 详细规格 | [G233 SoC 硬件手册][5] §9.3.2, §10 |

| 测试用例 | 测试内容 |
| --- | --- |
| `test_flash_identification` | 读取两片 Flash JEDEC ID：CS0=`0xEF3015`, CS1=`0xEF3016` |
| `test_individual_flash_operations` | 分别对两片 Flash 擦除/编程/读取，CS0 写 A-Z，CS1 写 a-z |
| `test_cross_flash_operations` | 交叉写入不同地址/模式（0xAA, 0x55, 0x33, 0xCC），验证不互相影响 |
| `test_alternating_operations` | 在两片 Flash 之间交替读取，验证片选切换不影响数据 |
| `test_flash_capacity` | CS0 测试 2MB 范围 (0x000000, 0x1F0000)，CS1 测试 4MB 范围 |
| `test_concurrent_status_check` | 同时检查两片 Flash 状态寄存器，验证片选控制正确 |

### 实验十 test-spi-overrun

| 项目 | 内容 |
| --- | --- |
| 源码路径 | `tests/gevico/qtest/test-spi-overrun.c` |
| 外设 | SPI 控制器（PLIC IRQ 5） |
| 功能描述 | 验证 SPI 溢出错误检测：中断模式和轮询模式 |
| 详细规格 | [G233 SoC 硬件手册][5] §9.3.3 |

| 测试用例 | 测试内容 |
| --- | --- |
| `test_interrupt_overrun_detection` | 使能 `ERRIE`，发送两字节但不读取第一字节，验证溢出中断触发 |
| `test_polling_overrun_detection` | 轮询方式检测 `SPI_SR.OVERRUN` 标志，验证写 `1` 清除机制 |

溢出原理：RXNE=1 时继续发送新数据 → 接收缓冲区满 → OVERRUN=1。

[1]: https://qemu.readthedocs.io/en/v10.0.3/devel/build-environment.html
[2]: https://github.com/riscv-collab/riscv-gnu-toolchain/releases/
[3]: https://classroom.github.com/a/hwWFrmo_
[4]: https://opencamp.cn/qemu/camp/2025/stage/3?tab=rank
[5]: https://qemu.gevico.online/exercise/2026/stage1/soc/g233-datasheet/
[6]: https://rust-lang.org/zh-CN/tools/install/
