# 本地质量门禁

执行命令：

```bash
pnpm quality:check
```

该脚本会按顺序执行以下检查：

1. `pnpm build`
2. `pnpm test`
3. `pnpm lint`
4. `cargo test`（`mtools-server`）
5. `cargo test`（`src-tauri`）

## 单项执行

```bash
pnpm build
pnpm test
pnpm lint
(cd mtools-server && cargo test)
(cd src-tauri && cargo test)
```

## 失败处理建议

1. 先修复 TypeScript 或 Rust 编译错误。
2. 再修复新增与存量单测失败。
3. 最后重新执行 `pnpm quality:check`，直至全部通过。
