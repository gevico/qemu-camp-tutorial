# QEMU PCIe 模拟方法

!!! note "主要贡献者"

    - 作者：[@zevorn](https://github.com/zevorn)

!!! info "QEMU 版本"

    本文基于 QEMU **v10.2.0**（tag: [`v10.2.0`](https://gitlab.com/qemu-project/qemu/-/tags/v10.2.0)，commit: `75eb8d57c6b9`）。

PCIe 是现代系统里最常见的外设互连总线之一。QEMU 在系统模式下会完整模拟 PCIe 拓扑、配置空间、BAR 映射、中断以及扩展能力，这让我们可以用纯软件复现“发现设备—配置资源—运行驱动”的真实流程。

本文给出一个通俗的全局视角：PCIe 在 QEMU 中被拆成哪些层次？配置空间如何读写？BAR 如何映射？以及如何基于这些机制建模一个 PCIe 设备。

!!! tip "概览"

    - PCIe 拓扑由 Host Bridge、Root Bus、Bridge/Port、Endpoint 组成
    - 配置空间由 PCIe 核心代码维护，支持 MSI/MSI-X 等能力
    - BAR 通过 MemoryRegion 绑定 MMIO/IO 空间
    - ECAM 提供 PCIe 配置空间的内存映射访问

## RC/EP 模式

PCIe 的基本运行模式可以理解为两类角色：

- **RC（Root Complex）**：系统的发起端，负责枚举、分配资源并发起事务。
- **EP（Endpoint）**：设备端，提供配置空间与 BAR，并响应访问。

RC/EP 示意：

```
                 +-------------------+
                 |   PCIe Fabric     |
                 | Switch/Root Port  |
                 +-------------------+
                    ^      ^      ^
                    |      |      |
         +----------+      |      +----------+
         |                 |                 |
+-----------+        +-----------+     +-----------+
| Node EP   |        | Node RC   |     | Node EP   |
| EP Device |        | CPU + RC  |     | EP Device |
+-----------+        +-----------+     +-----------+
  BAR/DMA    <-----    ECAM/MMI   ----->   BAR/DMA
  MSI/MSI-X   ---->     RC/CPU    <-----   MSI/MSI-X
```

一个典型流程是：

1. **链路训练**：RC 与 EP 建立物理链路。
2. **枚举配置**：RC 通过配置空间发现设备，分配 Bus/Device/Function。
3. **资源分配**：RC 为 EP 分配 BAR 地址、启用总线主控与中断。
4. **驱动加载**：操作系统加载驱动并开始正常 I/O。

要点是：RC 主导“发现 + 分配 + 管理”，EP 则按规范提供能力并执行事务。

!!! tip "注意要点"

    - RC 负责资源分配与拓扑管理，EP 需正确暴露配置空间与能力链。
    - BAR 大小由设备定义，写 BAR 时会触发映射更新。
    - MSI/MSI-X 属于配置空间能力的一部分，驱动开启后才会生效。
    - DMA 数据路径通常依赖 inbound/outbound 映射正确配置。

## iATU 机制

iATU（internal Address Translation Unit）用于做地址翻译，常见于 PCIe RC/EP 控制器。它通常提供 **outbound** 与 **inbound** 两类窗口：

- **Outbound**：CPU/RC 侧地址 -> PCIe 地址（用于 MMIO/CFG 访问）。
- **Inbound**：PCIe 侧地址 -> CPU/RC 侧地址（用于设备 DMA 访问主存）。

在 QEMU 的 DesignWare PCIe Host 模型里，会为不同方向的窗口创建对应的 `MemoryRegion` 映射：

```c
/* hw/pci-host/designware.c */
direction   = "Inbound";
source      = &host->pci.address_space_root;
destination = host_mem;
...
direction   = "Outbound";
source      = host_mem;
destination = &host->pci.memory;
```

示意：

```
CPU addr ----[ Outbound iATU ]----> PCIe addr
PCIe TLP ----[ Inbound  iATU ]----> Host mem
```

## 应用场景

PCIe 常见应用包括网卡、NVMe、GPU、加速卡等外设。以 GPGPU 为例，PCIe 通常负责两类路径：

- **控制路径**：CPU 通过 MMIO（BAR）写入命令队列或寄存器，触发 GPU 任务。
- **数据路径**：GPU 通过 DMA 读取/写入主存，完成数据搬运。

在运行时，驱动还会通过 MSI/MSI-X 接收设备完成中断，从而形成“命令提交—数据搬运—中断回报”的闭环。

## 结构层

在 QEMU 中，PCIe 设备层次大致是：

```
Host Bridge
  └─ PCIe Root Bus (pcie.0)
       ├─ Root Port / Downstream Port
       │    └─ Endpoint Devices
       └─ PCIe-to-PCI Bridge
```

对应到对象模型上，核心是 `PCIBus` 与 `PCIDevice`。PCIe 总线类型通常是 `TYPE_PCIE_BUS`，而具体的 Root Port、Downstream Port、Endpoint 则由不同的设备类型承载。

## 配置空间

配置空间读写由通用实现接管，QEMU 会根据写掩码更新字段，并触发 BAR 映射、中断控制与 MSI/MSI-X 状态更新：

```c
/* hw/pci/pci.c */
void pci_default_write_config(PCIDevice *d, uint32_t addr, uint32_t val_in, int l)
{
    ...
    if (ranges_overlap(addr, l, PCI_BASE_ADDRESS_0, 24) ||
        ranges_overlap(addr, l, PCI_ROM_ADDRESS, 4) ||
        ranges_overlap(addr, l, PCI_ROM_ADDRESS1, 4) ||
        range_covers_byte(addr, l, PCI_COMMAND) ||
        !!new_pm_state != !!old_pm_state) {
        pci_update_mappings(d);
    }

    if (ranges_overlap(addr, l, PCI_COMMAND, 2)) {
        pci_update_irq_disabled(d, was_irq_disabled);
        pci_set_master(d, (pci_get_word(d->config + PCI_COMMAND) &
                       PCI_COMMAND_MASTER) && d->enabled);
    }

    msi_write_config(d, addr, val_in, l);
    msix_write_config(d, addr, val_in, l);
    pcie_sriov_config_write(d, addr, val_in, l);
}
```

这段逻辑说明：配置空间并不只是“写寄存器”，它直接驱动 BAR 重新映射、总线主控位变化以及 MSI/MSI-X 机制更新。

## BAR 映射

BAR 的本质是“设备向系统申请一段地址空间”，在 QEMU 中通过 `MemoryRegion` 绑定到 PCI 设备：

```c
/* include/hw/pci/pci.h */
void pci_register_bar(PCIDevice *pci_dev, int region_num,
                      uint8_t attr, MemoryRegion *memory);
```

设备模型通常在 `realize` 阶段初始化 `MemoryRegion`，然后注册 BAR。这样 guest 驱动写 BAR 时，QEMU 就能把该 BAR 映射到指定的 MMIO 回调上。

## 扩展能力

PCIe 的能力（Capability）与扩展能力（Extended Capability）在 QEMU 中由辅助函数初始化，例如：

```c
/* include/hw/pci/pcie.h */
int pcie_cap_init(PCIDevice *dev, uint8_t offset, uint8_t type,
                  uint8_t port, Error **errp);
```

设备类型会选择合适的 `type`（Root Port、Downstream Port、Endpoint 等）来构建对应的能力链，之后才能被操作系统枚举与识别。

## 主桥 ECAM

PCIe 的配置空间访问通常依赖 ECAM（Enhanced Configuration Access Mechanism）。在 QEMU 的通用 PCIe Host（例如 GPEX）中，会创建 Root Bus 并配置 ECAM 基址/大小：

```c
/* hw/pci-host/gpex.c */
pci->bus = pci_register_root_bus(dev, "pcie.0", gpex_set_irq,
                                 gpex_swizzle_map_irq_fn,
                                 s, &s->io_mmio, &s->io_ioport, 0,
                                 s->num_irqs, TYPE_PCIE_BUS);

qdev_realize(DEVICE(&s->gpex_root), BUS(pci->bus), &error_fatal);
```

这部分逻辑让 guest 可以通过 ECAM 访问 PCIe 配置空间，从而完成枚举、分配 BAR、启用 MSI/MSI-X 等流程。

## 设备建模

一个典型 PCIe 设备建模流程如下：

1. 继承 `PCIDevice`，设置 `vendor_id/device_id/class_id`。
2. 初始化 BAR 对应的 `MemoryRegion`，注册到设备。
3. 初始化 PCIe 能力（`pcie_cap_init` 等）。
4. 在 MMIO 回调里实现寄存器行为与 DMA 访问。

这样驱动在 guest 中看到的，就会是“真实的 PCIe 设备”。

## 小结

QEMU 的 PCIe 模型把“拓扑、配置空间、BAR、能力链、ECAM”拆成清晰的模块。理解这些模块之间的关系，你就能更容易定位设备枚举失败、BAR 未生效或 MSI 不触发等常见问题，也能更稳妥地设计自己的 PCIe 设备模型。
