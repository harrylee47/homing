# ── 构建 ──────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# 只保留生产依赖
RUN pnpm prune --prod

# ── 运行 ──────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app

# 非 root 运行（计划 §12.4）
RUN addgroup -g 10001 -S gw && adduser -u 10001 -S gw -G gw

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# 控制台是纯静态文件，无构建步骤
COPY web ./web

# 数据目录由 volume 挂载，权限归运行用户
RUN mkdir -p /data && chown -R gw:gw /data
VOLUME /data
USER gw

ENV NODE_ENV=production \
    GW_DATA_DIR=/data \
    GW_HOST=0.0.0.0 \
    GW_PORT=8070

EXPOSE 8070

# 健康检查走自己的 /api/health，不额外引入 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8070/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/adapters/node/main.js"]
