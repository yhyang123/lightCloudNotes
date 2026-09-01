FROM node:20-alpine

LABEL org.opencontainers.image.title="nasCloudNote" \
      org.opencontainers.image.description="零依赖的自托管云笔记，适合部署在 NAS 上" \
      org.opencontainers.image.licenses="MIT"

# 无任何 npm 依赖，无需 npm install
WORKDIR /app

COPY server.js ./
COPY public ./public

# 数据持久化目录（挂载点）
# 必须 chown 给 node 用户：下方以 USER node 运行，而 RUN 默认以 root 建目录，
# 不改属主的话使用具名卷时容器内无写权限，服务启动即 EACCES 崩溃
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

EXPOSE 3000

# alpine 上以 node 用户运行更安全
USER node

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/tree >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
