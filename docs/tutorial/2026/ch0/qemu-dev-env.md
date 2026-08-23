# QEMU 编译开发环境搭建

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

本文介绍如何从零搭建 QEMU 编译开发环境，覆盖依赖安装、源码获取、编译配置、构建验证和开发工具配置等环节。文末附有基于 CNB 的云原生一键开发方案，适合希望跳过本地环境配置的同学快速上手。

## 系统要求

QEMU 支持在多种 Linux 发行版上构建，推荐使用以下系统：

| 发行版 | 推荐版本 |
|--------|----------|
| Ubuntu / Debian | 22.04 LTS 及以上 |
| Fedora | 38 及以上 |
| Arch Linux | 滚动更新 |

!!! tip "WSL 用户"

    Windows 用户可使用 WSL2 + Ubuntu，体验与原生 Linux 基本一致。安装 WSL2 后按 Ubuntu 流程操作即可。

## 安装依赖

### Ubuntu / Debian

```bash
sudo apt update
sudo apt install -y git build-essential python3 python3-venv \
    ninja-build pkg-config libglib2.0-dev libpixman-1-dev \
    libslirp-dev libfdt-dev zlib1g-dev
```

### Fedora

```bash
sudo dnf install -y git gcc g++ python3 ninja-build pkg-config \
    glib2-devel pixman-devel libslirp-devel libfdt-devel zlib-devel
```

### Arch Linux

```bash
sudo pacman -S --needed git base-devel python ninja pkgconf \
    glib2 pixman libslirp dtc
```

!!! note "完整依赖"

    以上为编译 QEMU 的最小依赖集。如需启用更多功能（如 GTK 图形界面、VNC、SPICE 等），请参考 [QEMU 官方构建文档][qemu-build-doc]。

## 获取源码

### 从官方仓库克隆

```bash
git clone https://gitlab.com/qemu-project/qemu.git
cd qemu
git submodule update --init --recursive
```

### 使用镜像源（可选）

如果 `gitlab.com` 访问不稳定，可使用 GitHub 镜像：

```bash
git clone https://github.com/qemu/qemu.git
```

!!! warning "版本选择"

    建议使用稳定版本分支进行学习，例如：

    ```bash
    git checkout v10.0.3
    ```

    如需跟踪最新开发进度，可使用 `master` 分支，但可能遇到构建不稳定的情况。

## 配置编译选项

QEMU 使用 Meson 构建系统，`./configure` 是其封装脚本。

### 最小化配置（推荐）

训练营课程主要使用 RISC-V 架构，建议只编译所需的 target 以加快构建速度。下面的命令从 **QEMU 源码根目录** 开始执行。配置和编译在 `build/` 中完成，随后回到源码根目录：

```bash
mkdir -p build
cd build
../configure --target-list=riscv64-softmmu --enable-slirp
ninja
cd ..
```

### 开发调试配置

如需使用 GDB 调试 QEMU 源码，添加调试信息：

```bash
mkdir -p build-debug
cd build-debug
../configure --target-list=riscv64-softmmu --enable-debug --enable-slirp
ninja
cd ..
```

### 常用配置参数

| 参数 | 说明 |
|------|------|
| `--target-list=` | 指定要编译的目标架构，多个用逗号分隔 |
| `--enable-debug` | 启用调试信息（-g -O0） |
| `--enable-slirp` | 启用用户态网络支持 |
| `--prefix=` | 指定安装路径，默认 `/usr/local` |
| `--enable-trace-backends=simple` | 启用简单 trace 后端 |

!!! tip "查看所有选项"

    ```bash
    ./configure --help
    ```

## 编译构建

```bash
ninja -C build
```

!!! note "编译时间参考"

    仅编译 `riscv64-softmmu` 时，在 8 核机器上通常只需几分钟。全量编译所有 target 可能需要更长时间。

## 验证安装

编译完成后，验证二进制是否可用：

```bash
./build/qemu-system-riscv64 --version
```

预期输出类似：

```
QEMU emulator version 10.0.3
Copyright (c) 2003-2025 Fabrice Bellard and the QEMU Project developers
```

运行一个简单的测试：

```bash
./build/qemu-system-riscv64 -machine virt -nographic -bios none
```

按 `Ctrl+A` 然后按 `X` 退出 QEMU。

## 开发工具配置

### compile_commands.json

Meson 在 configure 阶段会自动在 `build/` 目录下生成 `compile_commands.json`，无需手动执行额外命令。编译完成后即可直接使用，为 IDE 提供代码补全和跳转支持。

`build/compile_commands.json` 可被 VSCode（C/C++ 插件或 clangd）、Vim（coc-clangd）等编辑器识别。

### VSCode 配置

安装推荐插件：

- **clangd** — 代码补全、跳转、诊断（推荐替代 Microsoft C/C++ 插件）
- **CodeLLDB** 或 **Native Debug** — 图形化调试

在项目根目录创建 `.vscode/settings.json`：

```json
{
    "clangd.arguments": [
        "--compile-commands-dir=${workspaceFolder}/build"
    ]
}
```

### GDB 调试 QEMU

```bash
gdb --args ./build/qemu-system-riscv64 -machine virt -nographic -bios none
```

!!! tip "推荐阅读"

    调试技巧的详细介绍请参考基础阶段的 [常用调试方法](../ch1/qemu-debug.md)。

## Rust 开发环境配置（可选）

如需启用 QEMU 的 Rust 支持（用于 Rust 设备模型开发），需要额外安装 Rust 工具链和 bindgen：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
cargo install bindgen-cli
```

配置时添加 `--enable-rust` 并确保 `target-list` 包含 `riscv64-softmmu`：

```bash
mkdir -p build-rust
cd build-rust
../configure \
    --target-list=riscv64-softmmu \
    --enable-rust \
    --enable-slirp
ninja
cd ..
```

!!! tip "更多信息"

    Rust FFI 机制的详细介绍请参考专业阶段的 [Rust FFI](../ch2/qemu-rust-ffi.md)。

## 附录：CNB qemu-lab 云原生一键开发

如果你不想花时间在本地配置环境，可以使用 CNB（Cloud Native Build）平台提供的云端开发环境。`qemu-lab` 项目已经预配置了完整的 QEMU 编译环境，开箱即用。

### 什么是 CNB qemu-lab

`qemu-lab` 把"环境准备"前置到云端：你只需要 Fork 仓库并进入 CNB 工作区，就可以直接进入可构建、可调试的开发状态，无需手动安装任何依赖。

- 仓库地址：<https://cnb.cool/gevico.online/qemu-lab>
- 参考 README：<https://cnb.cool/gevico.online/qemu-lab/-/blob/main/README.md>

### 一键启动流程

#### 1) Fork 仓库

在浏览器打开 [qemu-lab 仓库](https://cnb.cool/gevico.online/qemu-lab)，点击 Fork 按钮，得到自己的仓库副本。

#### 2) 进入云原生开发环境

在你的仓库页面点击"云原生开发"，打开 Cloud IDE 工作区。首次进入时，平台会按仓库中的 `.cnb.yml` 与 `.ide/` 配置自动初始化环境。

!!! tip "团队协作"

    建议统一基于同一份 Fork 模板开展开发，降低"我这里能跑、你那边跑不起来"的概率。

#### 3) 获取并构建 QEMU

环境就绪后，在终端中执行：

```bash
git clone https://gitlab.com/qemu-project/qemu.git
cd qemu
./configure
make -j"$(nproc)"
```

#### 4) 推荐的日常开发节奏

1. 进入 CNB 工作区，等待环境初始化完成
2. 同步/更新 QEMU 源码
3. 执行一次完整构建，确认基线可用
4. 进行小步修改并局部验证
5. 需要复现问题时，直接分享仓库分支与命令序列

### 常见问题

!!! warning "初始化后命令不可用"

    先确认工作区初始化是否完成，再检查仓库中的 `.cnb.yml` 与 `.ide/` 是否被误改。

!!! warning "构建速度慢"

    检查并行参数是否生效：

    ```bash
    nproc
    make -j"$(nproc)"
    ```

    如果工作区规格较小，可先用较低并行度验证功能，再切换更高规格实例做全量构建。

!!! note "详细教程"

    更多关于 CNB 云原生开发的介绍请参考博客文章：[基于 CNB 一键启动 QEMU 开发环境](../../../blogs/misc/qemu-cnb-dev.md)。


[qemu-build-doc]: https://qemu.readthedocs.io/en/latest/devel/build-system.html
