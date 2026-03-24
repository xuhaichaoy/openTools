# `mtools-server` Docker 部署说明

本文档对应当前仓库中的：

- `/Users/haichao/Desktop/work/51ToolBox/mtools-server/Dockerfile`
- `/Users/haichao/Desktop/work/51ToolBox/mtools-server/docker-compose.prod.yml`

目标场景：

- 本地打包 `mtools-server` 生产镜像
- 上传镜像到服务器
- 服务器端只做 `docker load + docker compose up`

## 1. 前提

当前生产镜像已内置：

- `mtools-server`
- `ocr-models`
- `clawhub` CLI

其中团队技能中心服务端能力依赖镜像内的 `clawhub` 命令，包括：

- 团队配置验证
- 团队实时搜索
- 团队缓存同步
- 团队技能发布

## 2. 本地构建镜像

在项目根目录执行：

```bash
cd /Users/haichao/Desktop/work/51ToolBox/mtools-server
docker buildx build --platform linux/amd64 -t mtools-server:2026-03-24 --load .
```

如果服务器也是 `amd64`，建议固定使用 `linux/amd64` 构建。

## 3. 导出镜像文件

```bash
docker save mtools-server:2026-03-24 | gzip > mtools-server_2026-03-24.tar.gz
```

## 4. 生产环境配置

先复制一份环境变量模板：

```bash
cp /Users/haichao/Desktop/work/51ToolBox/mtools-server/.env.example /Users/haichao/Desktop/work/51ToolBox/mtools-server/.env.server
```

至少需要修改：

- `JWT_SECRET`
- `POSTGRES_PASSWORD`
- `ENCRYPTION_KEY`
- `PORT`
- `APP_IMAGE`

建议：

- `APP_IMAGE=mtools-server:2026-03-24`
- `ENCRYPTION_KEY` 一旦上线后不要变更，否则旧密文无法解密

生成命令：

```bash
openssl rand -hex 64
openssl rand -hex 16
openssl rand -base64 32
```

## 5. 上传到服务器

需要上传：

- 镜像包：`mtools-server_2026-03-24.tar.gz`
- 编排文件：`docker-compose.prod.yml`
- 环境文件：`.env.server`

示例：

```bash
scp mtools-server_2026-03-24.tar.gz user@server:/opt/mtools-server/
scp /Users/haichao/Desktop/work/51ToolBox/mtools-server/docker-compose.prod.yml user@server:/opt/mtools-server/
scp /Users/haichao/Desktop/work/51ToolBox/mtools-server/.env.server user@server:/opt/mtools-server/.env
```

## 6. 服务器启动

```bash
cd /opt/mtools-server
docker load -i mtools-server_2026-03-24.tar.gz
docker compose -f docker-compose.prod.yml --env-file .env up -d
```

说明：

- `docker-compose.prod.yml` 现在默认只使用 `APP_IMAGE`
- 不会在服务器端重新 build
- 应用启动时会自动执行数据库 migration

## 7. 验证

检查容器：

```bash
docker compose -f docker-compose.prod.yml ps
docker logs -f mtools-server
```

健康检查：

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/deploy-info
```

## 8. 更新版本

本地重新 build / save / 上传后，在服务器执行：

```bash
cd /opt/mtools-server
docker load -i mtools-server_2026-03-25.tar.gz
docker compose -f docker-compose.prod.yml --env-file .env up -d --force-recreate app
```

如果更新了镜像 tag，同步修改 `.env` 中的 `APP_IMAGE`。
