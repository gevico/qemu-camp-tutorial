# Rust FFI

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

Rust for QEMU 的核心目标不是“重写 QEMU”，而是让 Rust 设备与现有 C 基础设施协同工作。FFI（Foreign Function Interface）就是这套协同机制的中枢：它既要把 C API 暴露给 Rust，也要把 Rust 设备注册为 QOM 对象、回调与设备入口函数。本文基于将梳理 Rust FFI 在 QEMU 上的实现路径与关键机制。

!!! tip "概览"

    - FFI 分层：自动绑定 + 手工封装 + 设备实现
    - 绑定生成：`wrapper.h` + `bindgen` + `bindings.inc.rs`
    - Meson/Cargo 协作：`cargo_wrapper` 与 `build.rs` 的衔接
    - `Rust` -> `C：unsafe` 边界与安全包装（Opaque/Cell）
    - `C` -> `Rust：extern "C"` 入口与 QOM 回调桥接
    - 回调机制：`*mut c_void` -> `Rust` 引用的转换

## FFI 分层

Rust in QEMU 的接口分为三层：**自动生成绑定**、**手工封装的中间层**、**设备/模块实现层**。这对应 QEMU 源码中的 `rust/` 目录结构：`qom`、`hw/core`、`system`、`util` 等 crate 提供薄封装与安全抽象，而具体设备（如 `pl011`、`hpet`）在 `rust/hw/*` 中实现。

示意图：

```
Device/Module (rust/hw/*)
        |
  Mid-layer (qom/hwcore/system/util)
        |
  Auto bindings (bindgen)
        |
      C APIs
```

构建入口仍由 Meson 驱动：`configure --enable-rust` 会启用 Rust 构建，随后 Meson 调用 `scripts/cargo_wrapper.py` 驱动 Cargo，保证 Rust 与 C 侧的配置一致（见 `docs/devel/rust.rst`）。

## 绑定生成

QEMU 的 Rust 绑定以 **wrapper.h + bindgen** 的方式生成。每个 Rust crate 通常有一个 `wrapper.h` 指定需要暴露的 C 头文件，然后在对应 `meson.build` 中调用 `rust.bindgen` 生成 `bindings.inc.rs`。

以 `pl011` 设备为例，Meson 会这样生成绑定：

```meson
_libpl011_bindings_inc_rs = rust.bindgen(
  input: 'wrapper.h',
  output: 'bindings.inc.rs',
  bindgen_version: ['>=0.60.0'],
  args: bindgen_args_common,
  c_args: bindgen_c_args,
)
```

`wrapper.h` 明确声明 bindgen 输入范围，并处理 libclang 兼容问题：

```c
/*
 * This header file is meant to be used as input to the `bindgen` application
 * in order to generate C FFI compatible Rust bindings.
 */
#ifndef __CLANG_STDATOMIC_H
#define __CLANG_STDATOMIC_H
typedef enum memory_order { /* ... */ } memory_order;
#endif

#include "qemu/osdep.h"
#include "hw/char/pl011.h"
```

这保证绑定生成集中、可控，避免把整个 C API 暴露到 Rust 侧。

## 构建协作

Rust 代码依赖 `bindings.inc.rs`，但该文件由 Meson 在构建目录生成。QEMU 通过 `build.rs` 把生成文件“链接”到 Cargo 输出目录：

```rust
let file = if let Ok(root) = env::var("MESON_BUILD_ROOT") {
    format!("{root}/{sub}/bindings.inc.rs")
} else {
    format!("{manifest_dir}/src/bindings.inc.rs")
};
// symlink to OUT_DIR/bindings.inc.rs
```

这个机制保证：**Meson 负责生成绑定，Cargo 负责消费绑定**。如果直接运行 `cargo clippy` 或 `cargo fmt`，需要通过 `meson devenv` 或 `MESON_BUILD_ROOT` 配置来找到生成文件。具体可以阅读 QEMU 源码中 `docs/devel/rust.rst` 的文档。

## Rust 调用 C

`bindgen` 生成的类型与函数是 **原始 FFI 层**，需要在 Rust 侧进行安全封装。QEMU 采用 `Opaque<T>` 等类型隔离 C 结构体的不安全行为，并通过 `BqlCell/BqlRefCell` 管理并发可变性：

```rust
#[repr(transparent)]
pub struct Opaque<T> {
    value: UnsafeCell<MaybeUninit<T>>,
    _pin: PhantomPinned,
}

impl<T> Opaque<T> {
    pub unsafe fn from_raw<'a>(ptr: *mut T) -> &'a Self { /* ... */ }
    pub const unsafe fn uninit() -> Self { /* ... */ }
}
```

这一层让 `unsafe` 集中在最底部，设备实现层可以尽量保持安全 Rust 代码。

## C 回调 Rust

Rust 设备需要对 C 侧暴露入口函数，例如 `pl011_create` 使用 `extern "C"` 与 `#[no_mangle]` 直接提供给 C 调用：

```rust
#[no_mangle]
pub unsafe extern "C" fn pl011_create(
    addr: u64,
    irq: *mut IRQState,
    chr: *mut Chardev,
) -> *mut DeviceState {
    /* ... */
    dev.as_mut_ptr()
}
```

另一方面，QOM 需要注册 `class_init / instance_init` 等回调。`rust/qom` 通过泛型桥接函数把 QOM 的函数指针映射到 Rust trait：

```rust
unsafe extern "C" fn rust_class_init<T: ObjectType + ObjectImpl>(
    klass: *mut ObjectClass,
    _data: *const c_void,
) {
    <T as ObjectImpl>::CLASS_INIT(unsafe { klass.as_mut() })
}
```

这些 `extern "C"` 入口函数就是 Rust 设备进入 QEMU 对象模型的“钩子”。

## 回调机制

QEMU 设备常见回调（定时器、IRQ、chardev 等）都采用 C 风格的 `void* opaque`。Rust 侧通过 `common::callbacks::FnCall` 的泛型技巧生成“单态化回调桥”，把 `*mut c_void` 转回 Rust 引用：

```rust
unsafe extern "C" fn rust_bh_cb<T, F: for<'a> FnCall<(&'a T,)>>(
    opaque: *mut c_void,
) {
    F::call((unsafe { &*(opaque.cast::<T>()) }, ))
}
```

这种方式既满足 C ABI，又让 Rust 侧保留类型信息，避免大量手写回调样板代码。

## 调用链示意

```
Rust device -> (safe wrapper) -> bindings::C_API -> C core
   ^                                            |
   |                                            v
extern "C" entry <------- QOM/Callback ------- C ABI
```

Rust 设备通过安全封装调用 C API，C 侧通过 `extern "C"` 入口与回调把控制权交回 Rust，这构成一个完整的闭环。

## 本章小结

Rust for QEMU 的 FFI 机制有三个关键词：**分层**、**生成**、**桥接**。分层让 unsafe 最小化，生成让绑定一致可控，桥接让 Rust 设备像 C 设备一样接入 QOM 与系统运行时。理解这一套 FFI 链路，就能在 QEMU 中实现可维护、可演进的 Rust 设备模型。
