# 官方插件发布流程

## 前置条件
- Node.js 20（建议：`nvm use 20`）
- `pnpm` 可用
- 系统安装 `zip` 命令
- 数据库已执行插件市场迁移（含 `plugin_market_releases`）

## 目录结构
- 官方插件源码：`official-plugins/<slug>/`
- 构建产物：`official-plugins/dist/`
- 默认发布目录：`mtools-server/uploads/plugins/official/`

## 1. 构建官方插件包
```bash
pnpm official:build
```

输出：
- `official-plugins/dist/<slug>-<version>.zip`
- `official-plugins/dist/release-manifest.json`

## 2. 发布到服务端静态目录并生成 SQL
```bash
pnpm official:publish
```

可选自定义发布目录：
```bash
PLUGIN_UPLOAD_DIR=/absolute/path/to/uploads/plugins/official pnpm official:publish
```

输出：
- 复制 zip 到 `uploads/plugins/official/<slug>/<version>.zip`
- 生成 `official-plugins/dist/publish.sql`

## 3. 执行 SQL 上线版本
将 `official-plugins/dist/publish.sql` 在服务器 PostgreSQL 中执行。

SQL 会：
- Upsert `plugin_market_apps`（`is_official=true`）
- Upsert `plugin_market_releases`
- 更新 `plugin_market_apps.current_release_id`

## 4. 校验
1. 调用 `GET /v1/plugins/market/apps`，确认 `isOfficial/currentVersion/packageSizeBytes`。
2. 调用 `GET /v1/plugins/market/apps/{slug}/package`，确认 `downloadUrl/packageSha256`。
3. 客户端插件市场安装并验证可打开。

## 回滚
1. 将目标版本在 `plugin_market_releases.status` 标记为 `archived`。
2. 将 `plugin_market_apps.current_release_id` 指回上一个稳定版本。
3. 必要时删除对应上传目录下的 zip。
