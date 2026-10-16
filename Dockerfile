# 履约系统镜像：Nuxt 构建产物 + Prisma 迁移文件。
# 构建：docker build -t fulfillment-tracker .
# 迁移：docker compose run --rm fulfillment npx prisma migrate deploy（上线前人工执行，不在启动时自动跑）

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm exec prisma generate
COPY . .
RUN pnpm exec nuxt prepare && pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
# 只为执行 prisma migrate deploy
RUN npm install -g prisma@6.19.3 && npm cache clean --force
COPY --from=build /app/.output ./.output
COPY --from=build /app/prisma ./prisma
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", ".output/server/index.mjs"]
