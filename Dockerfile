# 使用官方 Node.js 22 Alpine 镜像 (轻量级，支持 amd64 / arm64 多架构)
FROM node:22-alpine

# 设置工作目录
WORKDIR /app

# 添加元数据
LABEL maintainer="CoreFeed Contributors"
LABEL version="2.0.0"
LABEL description="CoreFeed v2.0 - Global News Intelligence & Editorial Briefing Platform"

# 安装系统依赖与时区数据（确保 08:00 / 12:30 / 19:30 定时同步按北京时间触发）
RUN apk add --no-cache \
    wget \
    curl \
    tzdata \
    dumb-init \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && rm -rf /var/cache/apk/*

# 复制 package 文件并安装生产依赖
COPY package*.json ./
RUN npm ci --omit=dev && \
    npm cache clean --force

# 复制应用代码
COPY . .

# 创建持久化目录
RUN mkdir -p /app/data /app/logs

# 默认环境变量
ENV NODE_ENV=production
ENV PORT=3120
ENV TZ=Asia/Shanghai

# 暴露端口
EXPOSE 3120

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3120/api/health || exit 1

# 使用 dumb-init 启动应用，确保信号正确转发
CMD ["dumb-init", "node", "server.js"]