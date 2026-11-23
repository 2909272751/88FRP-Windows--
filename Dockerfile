# ---- Stage 1: Build ----
FROM node:22-alpine AS build

WORKDIR /app

# 只复制依赖相关文件，利用 Docker 缓存层
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 2: Caddy with Cloudflare DNS ----
FROM golang:1.26.0-alpine AS caddy-build

ARG TARGETARCH=amd64

RUN apk add --no-cache git ca-certificates
RUN go install github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.7
RUN case "$TARGETARCH" in amd64|arm64) ;; *) echo "Unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; esac \
    && CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" /go/bin/xcaddy build v2.11.9 \
    --with github.com/caddy-dns/cloudflare@v0.2.4 \
    --output /out/caddy

# ---- Stage 3: Production ----
FROM node:22-alpine

ARG TARGETARCH=amd64

WORKDIR /app

# 设置默认环境变量
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8801 \
    DATA_DIR=/app/data \
    APP_BASE_DIR=/app \
    APP_RUNTIME_DIR=/app/runtime \
    AGENT_HOST=0.0.0.0 \
    AGENT_PORT=19688

# 创建数据目录和运行时目录
RUN mkdir -p /app/data /app/runtime

# 从 build 阶段复制 node_modules
COPY --from=build /app/node_modules ./node_modules

# 复制应用源码和二进制文件
COPY src/ ./src/
COPY bin/ ./bin/
COPY --from=caddy-build /out/caddy /app/bin/${TARGETARCH}/caddy

# 确保 Linux 下的 frpc 二进制可执行
RUN chmod +x /app/bin/amd64/88frpc /app/bin/arm64/88frpc /app/bin/${TARGETARCH}/caddy 2>/dev/null || true

# 暴露端口
EXPOSE 8801 19688 7777

# 启动 web 服务
CMD ["node", "src/web/server.js"]
