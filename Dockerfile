# 使用官方Node.js 22 Alpine镜像作为基础镜像 (最新LTS版本)
FROM node:22-alpine

# 设置工作目录
WORKDIR /app

# 添加元数据
LABEL maintainer="Alan Sun"
LABEL version="1.3.2"
LABEL description="A news aggregator website with AI translation and summarization"

# 安装系统依赖
RUN apk add --no-cache \
    wget \
    curl \
    dumb-init \
    && rm -rf /var/cache/apk/*

# 复制package文件
COPY package*.json ./

# 安装Node.js依赖
RUN npm ci --only=production && \
    npm cache clean --force

# 创建非root用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# 创建必要的目录并设置权限
RUN mkdir -p /app/data /app/logs && \
    chown -R nodejs:nodejs /app

# 复制应用代码
COPY --chown=nodejs:nodejs . .

# 切换到非root用户
USER nodejs

# 暴露端口
EXPOSE 3120

# 设置默认端口环境变量
ENV PORT=3120

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3120/api/health || exit 1

# 启动应用
CMD ["dumb-init", "npm", "start"]