# ---- Stage 1: Build ----
FROM node:22-alpine AS build

WORKDIR /app

# 只复制依赖相关文件，利用 Docker 缓存层
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 2: Production ----
FROM node:22-alpine

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

# 确保 Linux 下的 frpc 二进制可执行
RUN chmod +x /app/bin/amd64/88frpc /app/bin/arm64/88frpc 2>/dev/null || true

# 暴露端口
EXPOSE 8801 19688

# 启动 web 服务
CMD ["node", "src/web/server.js"]
