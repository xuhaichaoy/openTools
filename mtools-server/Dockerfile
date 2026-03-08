# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM rust:latest AS builder

WORKDIR /app

# 1) 只拷贝依赖清单，用空壳项目预编译所有依赖（此层仅在 Cargo.toml/lock 变化时重建）
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
    && echo "fn main() {}" > src/main.rs \
    && echo "" > src/lib.rs \
    && cargo build --release \
    && rm -rf src

# 2) 拷贝真实源码，只增量编译项目自身代码
COPY src ./src
COPY migrations ./migrations
RUN touch src/main.rs src/lib.rs && cargo build --release

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install ONNX Runtime
ARG ORT_VERSION=1.22.0
RUN curl -fSL "https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-linux-x64-${ORT_VERSION}.tgz" \
    -o /tmp/ort.tgz \
    && tar xzf /tmp/ort.tgz -C /tmp \
    && cp /tmp/onnxruntime-linux-x64-${ORT_VERSION}/lib/libonnxruntime.so* /usr/local/lib/ \
    && ldconfig \
    && rm -rf /tmp/ort.tgz /tmp/onnxruntime-linux-x64-${ORT_VERSION}

WORKDIR /app

COPY --from=builder /app/target/release/mtools-server .
COPY --from=builder /app/migrations ./migrations
COPY ocr-models ./ocr-models

ENV OCR_MODEL_DIR=./ocr-models

EXPOSE 3000

CMD ["./mtools-server"]
