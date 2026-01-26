# Rust 单测开发

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

本文介绍如何基于 Rust for QEMU 框架编写单元测试。重点是测试入口、写法模式、绑定生成依赖，以及设备代码的可测性拆分策略。

!!! tip "概览"

    - 测试入口：Meson 构建与 rust 测试套件
    - 写法模式：`#[cfg(test)]` + `#[test]`
    - 绑定依赖：`bindings.inc.rs` 与 build.rs
    - 运行方式：`make check-rust` / `meson test --suite rust`
    - 设备侧测试：逻辑拆分与最小化依赖

## 测试入口

Rust for QEMU 的测试入口由 Meson 统一驱动。推荐的手工运行方式是：

```bash
RUST_BACKTRACE=1 make check-rust
# or
RUST_BACKTRACE=1 ./pyvenv/bin/meson test -C build --suite rust
```

Rust 代码会以静态库形式与 C 侧链接，因此不建议直接使用 `cargo test` 运行测试用例。

## 写法模式

单元测试通常以内嵌模块的方式编写，与常规 Rust 项目一致：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mask() {
        assert_eq!(u32::mask(8, 8), 0xff00);
    }
}
```

在 QEMU 的 Rust 代码中，`common`、`util` 等 crate 已经大量采用该模式，适合直接参考。

## 绑定依赖

Rust 侧需要 `bindings.inc.rs`，它由 Meson 调用 bindgen 生成，并通过 `build.rs` 软链接到 `OUT_DIR`。因此：

- **必须先完成 Meson 构建**，否则会找不到绑定文件；
- 若需要使用 Cargo 子命令，可使用 `meson devenv` 或设置 `MESON_BUILD_ROOT`。

## 设备侧测试

设备代码往往依赖 QEMU 的全局状态（例如 BQL 约束、QOM 生命周期或 DMA 访问）。为了让单元测试可运行，建议：

1. **把纯逻辑拆出为独立函数**，避免直接依赖 QOM/设备对象。
2. **减少对 C API 的依赖**，单测优先覆盖 Rust 逻辑路径。
3. **必要时使用最小化上下文**，例如只验证寄存器读写与状态转换。

这种拆分能显著降低测试成本，也能避免在单测中引入系统级初始化。

## 运行方式

常用的本地验证流程如下：

```bash
./pyvenv/bin/meson compile -C build
RUST_BACKTRACE=1 ./pyvenv/bin/meson test -C build --suite rust
```

如果只需要格式化或静态检查，可用 Meson 提供的入口：

```bash
make rustfmt
make clippy
```

## 常见问题

- **找不到 bindings.inc.rs**：确认已完成 Meson 构建，且 `MESON_BUILD_ROOT` 指向构建目录。
- **cargo test 失败**：Rust 测试需要 C 侧对象文件，必须通过 Meson 运行。
- **测试用例与设备代码强耦合**：优先拆出纯逻辑函数再做单测。
