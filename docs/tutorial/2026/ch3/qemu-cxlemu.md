# 基于 CXLMemSim 与 QEMU 的 Kimi K2.6 Ternary 推理后端优化

## 项目简介

本项目在 QEMU + CXLMemSim 构建的 CXL Type-2 加速器仿真环境中，围绕真实大模型 Kimi K2.6（IQ1_M / ternary 量化）构建一条"先正确、后性能"的异构推理链路。Guest 内的 CUDA 应用无需改动，通过 `libnvcuda.so` shim（ZLUDA 路线）将 CUDA Driver API 翻译为设备命令，由 ternary 后端实际执行；Host 侧在 QEMU CXL Type-2 设备模型与 CXLMemSim backing store 之上，负责设备内存仿真与 KV/权重的存储供给。

项目以基线仓库 `vickiegpt/Concordia`（`tmatmul` 分支，基准 `bench/kimi_k26_tps/`）为起点，核心优化对象是 **back storage（后端存储 / 供数路径）**，并以 Kimi K2.6 在固定 GPU 资源下的推理吞吐作为打榜指标。

## 项目方向

1. **功能验证：Kimi K2.6 跑正确（入围门槛）**
   - VM 内经 shim 路径完整跑通 Kimi K2.6 IQ1_M，`concordia` 结果与 `baseline` 对齐。

2. **核心优化：back storage（后端存储与供数路径）**
   - 优化 Concordia AOF 与 CXLMemSim backing store（`--ssd-backing-file` 的缓存、预取、io_uring/O_DIRECT、页大小等），在固定 GPU 资源下提升供数效率。

3. **JIT：ternary kernel 动态 codegen**
   - 将 tmatmul 以三值低比特执行（`HetGPUBackendType` 扩展 / Concordia tmatmul 路径），与 dense 基线对比加速比。

4. **进阶：多节点解耦推理**
   - 多节点、每节点算不同部分（prefill/decode 解耦或 MoE expert 分片），KV cache 跨节点放置借助 CXLMemSim 分布式模式。

## 考核标准

- **性能（主）**：相同 GPU 资源、相同 VM 环境、相同 Kimi K2.6 workload 下，以推理吞吐（`tps`，经 `run_kimi_k26_tps.sh` 采集到 CSV/JSONL）打榜排名。
- **正确性（门槛）**：`concordia` 路径产出须与 `baseline` 对齐，跑不对者不计入榜单。
- **技术报告（必须）**：包含项目成果、代码链接、可复现的运行日志与配置。

## 相关学习资料

- CXLMemSim - [GitHub](https://github.com/SlugLab/CXLMemSim) · [论文 arXiv](https://arxiv.org/abs/2303.06153)
- 基线仓库 Concordia - [GitHub（tmatmul 分支）](https://github.com/vickiegpt/Concordia/tree/tmatmul)
- hetGPU - [论文 arXiv](https://arxiv.org/abs/2506.15993)
- NVIDIA Dynamo - [Developer](https://developer.nvidia.com/dynamo) · [架构文档](https://docs.dynamo.nvidia.com/dynamo/design-docs/overall-architecture)
- QEMU 官方 CXL 文档 - [docs](https://www.qemu.org/docs/master/system/devices/cxl.html)
- tutorial 页面 - [qemu-cxlemu](https://qemu.gevico.online/tutorial/2026/ch3/qemu-cxlemu/)