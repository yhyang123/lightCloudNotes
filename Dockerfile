FROM node:20-alpine

# 无任何 npm 依赖，无需 npm install
WORKDIR /app

COPY server.js ./
COPY public ./public

# 数据持久化目录（挂载点）
RUN mkdir -p /app/data/uploads

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

EXPOSE 3000

# alpine 上以 node 用户运行更安全
USER node

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/tree >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
