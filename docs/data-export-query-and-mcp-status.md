# 数据查询协议与 MCP 状态

## 1. 文档目的

这份文档用于同步最近两条变化很大的能力线：

1. 数据查询 / 导出从“自然语言 + 临时规则”继续收口到 `dbproto/v1`
2. MCP 传输从“能跑就行”升级为更标准的协议实现

本文只描述截至 2026-03-24 的真实代码状态，不把未实现内容写成已完成。

---

## 2. 数据查询 / 导出当前状态

### 2.1 `dbproto/v1` 已经覆盖的动作

当前 `src/core/data-export/db-protocol.ts` 已支持：

- `delegate`
- `list_namespaces`
- `namespace_exists`
- `list_tables`
- `describe_table`
- `sample_table`
- `search_tables`
- `list_datasets`
- `describe_dataset`

这意味着数据库元数据查询已经不再只靠 prompt 猜测，而是有稳定的协议动作和参数结构。

### 2.2 follow-up 已进入结构化上下文

`src/core/data-export/types.ts` 里的 `ExportProtocolContext` 已经承载：

- `sourceId`
- `namespace`
- `table`
- `datasetId`
- `keyword`
- `action`

`src/core/data-export/im-data-export-runtime-manager.ts` 会把这层信息保存为 `lastProtocolContext`。实际效果是：

- 用户先说 `athena_user`
- 下一句再说“看一下这个库里有哪些表”

系统可以基于结构化上下文继续查，而不是每一轮都重新靠模型猜“这个库”指的是谁。

### 2.3 当前已经真实可用的查询能力

当前代码和测试已经覆盖两类能力：

1. **只读元数据查询**
   - 查 schema / namespace
   - 查库是否存在
   - 列表表
   - 看表结构
   - 看表样本
   - 搜索表
   - 列 dataset
   - 看 dataset 定义

2. **部分真实业务查询 / 导出前预览**
   - `export-agent` 已有 deterministic business fallback
   - 可以把部分自然语言请求解析为 `StructuredExportIntent`
   - 已有 `preview -> 确认导出` 的运行链
   - 相关测试已覆盖“查公司信息”“查联系人和电话”“确认导出防重复”等场景

因此，当前状态不是“只会写死返回示例”，也不是“只有元数据查询”，而是：

- 元数据查询已经明显走向 protocol-first
- 业务查询与导出链已经有真实执行路径
- 但自然语言理解层还没有完全摆脱规则依赖

### 2.4 当前还没有完全做透的地方

最准确的说法是：**现在不是写死库名 / 表名，但用户怎么说这件事仍有规则 fallback。**

当前仍可见的规则/启发式包括：

- `classifyExportMetadataQuestion`
- `isCurrentNamespaceTableListRequest`
- `isCurrentTableDescribeRequest`
- `isCurrentTableSampleRequest`
- `extractNamespaceExistenceTarget`
- `parseExplicitTableInspectionRequest`
- `detectDeterministicBusinessKind`
- `extractCompanyKeyword`

这说明目前的状态更接近：

- 查询执行：已经能真查
- 查询上下文：已经能跨轮承接
- 查询理解：仍有 protocol + rules + model 的混合态

### 2.5 当前最该继续补的方向

1. 把“自然语言查业务数据 -> `preview_export` -> `confirm_export`”继续收口到同一套协议，而不是 metadata 一套、预览/确认另一套。
2. 让 query 理解更像状态机 / 协议驱动，而不是继续堆 regex fallback。
3. 让查询会话上下文不只活在 export runtime 里，而是进入更高层的统一 session control plane。

### 2.6 当前已跑过的相关验证

最近已通过的检查包括：

- `pnpm -s vitest run src/core/data-export/db-protocol.test.ts src/core/data-export/export-agent-run.test.ts src/core/data-export/im-data-export-runtime-manager.test.ts`
- `pnpm -s tsc --noEmit`

---

## 3. MCP 当前状态

### 3.1 已修复的核心问题

之前 Chrome DevTools MCP 启动时报：

- `JSON Parse error: Unexpected EOF`

根因不是服务器本身坏了，而是本地 stdio transport 把 MCP 服务端当成“按行 JSON”读写；但 Chrome DevTools MCP 使用的是标准 `Content-Length` framed MCP stdio。

当前修复已经落到：

- `src-tauri/src/commands/mcp.rs`
- `src-tauri/src/lib.rs`
- `src/store/mcp-store.ts`
- `src/core/agent/cluster/mcp-agent-bridge.ts`

### 3.2 当前实现已经对齐的点

1. stdio 传输已改为标准 `Content-Length` framing
2. 新增了 `send_mcp_notification`
3. `initialize` 后会发送真正的 `notifications/initialized`
4. 前端 store 和 MCP agent bridge 都走同样的握手语义
5. `stderr` 日志会持续透出，便于排查 server 启动问题

### 3.3 这意味着什么

当前最重要的变化不是“某一个 MCP server 特判成功了”，而是底层 transport 从非标准实现切回了标准 MCP 心智。  
这对 Chrome DevTools MCP、后续其他 stdio MCP server，以及未来的协议兼容性都更稳。

### 3.4 当前已跑过的相关验证

最近已通过的检查包括：

- `pnpm -s vitest run src/store/mcp-store.test.ts`
- `cargo test --manifest-path src-tauri/Cargo.toml mcp::tests -- --nocapture`
- `cargo check --manifest-path src-tauri/Cargo.toml`

---

## 4. 一句话结论

截至 2026-03-24：

- 数据查询 / 导出已经从“纯 prompt + 临时规则”进化到“`dbproto/v1` + protocol context + 部分真实查询/预览执行”的混合稳定态；
- MCP 已经从“非标准 stdio 侥幸可用”修到了“标准 framing + notification 握手”的可扩展状态；
- 下一波最值得做的不是再加更多特判，而是把查询协议和会话控制继续收口成单一真相。
