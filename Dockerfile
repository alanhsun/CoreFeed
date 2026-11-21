# 使用官方 Node.js 22 Alpine 锁定版本镜像 (轻量级，支持 amd64 / arm64 多架构)
FROM node:22-alpine3.21

ARG APP_VERSION=3.0.0

# 设置工作目录
WORKDIR /app

# 添加元数据
LABEL maintainer="CoreFeed Contributors"
LABEL version="${APP_VERSION}"
LABEL description="CoreFeed v3.0 - Global News Intelligence & Editorial Briefing Platform"

# 安装系统依赖、时区数据与轻量降权工具 su-exec
RUN apk add --no-cache \
    wget \
    curl \
    tzdata \
    dumb-init \
    su-exec \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && rm -rf /var/cache/apk/*

# 复制 package 文件并安装生产依赖（devDependencies 如 eslint 不进入镜像）
COPY package*.json ./
RUN npm ci --omit=dev && \
    npm cache clean --force

# 安装非 root 降权入口脚本（确保跨平台检出均具备可执行权限）
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# 复制应用代码并归属至内置非 root 用户 node (UID 1000)
COPY . .
RUN mkdir -p /app/data /app/logs && \
    chown -R node:node /app

# 默认环境变量
ENV NODE_ENV=production
ENV PORT=3120
ENV TZ=Asia/Shanghai

# 暴露端口
EXPOSE 3120

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3120/api/health || exit 1

# 通过入口脚本修正挂载卷权限后永久降权为 node (UID 1000) + dumb-init 运行业务进程
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]