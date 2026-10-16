# 项目履约系统（Fulfillment Tracker）

外协交接闭环：外协返厂报检（QMS）→ 下工序待办 → 停滞预警 → 异常升级。
设计依据：项目文件 `履约流程/系统方案设计.md`、`履约流程/技术选型与MVP范围.md`。

技术栈：Nuxt 3（Nitro 服务端）+ Prisma 6 + MySQL 8；电脑端 Ant Design Vue，手机端（`/m`）Vant。Node 22，pnpm。

## 本地启动

```bash
pnpm install
cp .env.example .env                          # 按注释填写
docker compose -f docker-compose.local.yml up -d   # 本地 MySQL；已有 QMS 本地 MySQL 的话在那里建 fulfillment 库即可
pnpm db:migrate                               # 建表
pnpm cert:local                               # mkcert 生成 https://localhost 证书（身份桥只接受 https 回调）
pnpm dev                                      # https://localhost:3100
```

登录走 QMS 身份桥（接口见 `server/services/auth/identity-bridge.ts` 顶部注释，依据 QMS `apps/backend/modules/identity-bridge`）。QMS 本地还没跑起来时，可以先用模拟身份桥：

```bash
node scripts/mock-identity-bridge.mjs         # 监听 4100，自动以"测试外协专员"同意授权
# .env 中改为：
# NUXT_QMS_API_BASE="http://localhost:4100"
# NUXT_QMS_AUTHORIZE_URL="http://localhost:4100/authorize"
# NUXT_QMS_CLIENT_SECRET="local-dev-secret-local-dev-secret-0"
```

## 检查

| 命令 | 内容 |
|---|---|
| `pnpm typecheck` | 页面与服务端类型检查 |
| `pnpm test` | 核心单元测试 |
| `pnpm build && TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration` | 登录走通集成测试（真实构建产物 + 真实 MySQL + 模拟身份桥）。测试库必须是专用库 |

## 部署（与 QMS 同机）

```bash
docker compose build
docker compose run --rm fulfillment prisma migrate deploy   # 上线前人工执行
docker compose up -d
```

容器加入 QMS 的 `qms-network`，经 `http://qms-backend:3000` 调用身份桥；端口只绑 `127.0.0.1:3100`，由 443 入口（IP 证书）反向代理。

## 环境变量

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 履约库连接串。生产账号只授予 `fulfillment` 库权限 |
| `NUXT_QMS_API_BASE` | QMS 后端地址（服务端调用）。生产 `http://qms-backend:3000` |
| `NUXT_QMS_AUTHORIZE_URL` | QMS 授权页完整地址（浏览器跳转）。本地 `http://localhost:5666/identity/authorize`，生产 `http://<IP>/#/identity/authorize` |
| `NUXT_QMS_CLIENT_ID` / `NUXT_QMS_CLIENT_SECRET` | 与 QMS 的 `QMS_IDENTITY_CLIENT_ID` / `QMS_IDENTITY_CLIENT_SECRET` 一致，密钥 ≥32 位 |
| `NUXT_QMS_CALLBACK_URL` | 回调地址，必须 https、不带 `?` `#`，与 QMS 的 `QMS_IDENTITY_CALLBACK` 完全一致 |
| `DEV_HTTPS_KEY` / `DEV_HTTPS_CERT` | 仅本地开发：mkcert 证书路径 |

缺少必填项时服务启动即报错退出。
