# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM rust:1.85-slim AS builder

WORKDIR /app

# 依赖层缓存：先只复制 Cargo 文件，让依赖编译结果可以被 Docker 层缓存复用
COPY Cargo.toml Cargo.lock ./

# 创建虚拟 main.rs，触发依赖编译
RUN mkdir src && echo "fn main(){}" > src/main.rs && \
    cargo build --release && \
    rm -rf src

# 复制真实源码和迁移文件
COPY src ./src
COPY migrations ./migrations

# 强制重新编译（touch 让 cargo 感知到源码变化）
RUN touch src/main.rs && cargo build --release

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM debian:bookworm-slim

# 仅需 CA 证书（用于 reqwest HTTPS 请求）
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/target/release/mtools-server .
COPY --from=builder /app/migrations ./migrations

EXPOSE 3000

CMD ["./mtools-server"]
