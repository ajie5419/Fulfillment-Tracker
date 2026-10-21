// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  future: { compatibilityVersion: 4 }, // 源码放 app/ 目录
  devtools: { enabled: false },
  modules: ['@ant-design-vue/nuxt', '@vant/nuxt'],
  antd: { extractStyle: true }, // 服务端渲染时内联首屏样式，避免先闪一下无样式页面
  css: ['~/assets/base.css'],
  typescript: { strict: true, typeCheck: false },

  // 全部可被同名 NUXT_* 环境变量覆盖，见 .env.example
  runtimeConfig: {
    devTools: false, // NUXT_DEV_TOOLS=1 时开启演示数据和模拟报检（/api/dev/*），生产不要开
    adminUserIds: '', // NUXT_ADMIN_USER_IDS，逗号分隔的 QMS 用户 ID，可进设置页
    uploadDir: './data/uploads', // NUXT_UPLOAD_DIR，异常照片的存放目录（相对路径按启动目录算）
    qms: {
      apiBase: 'http://qms-backend:3000', // NUXT_QMS_API_BASE
      authorizeUrl: '', // NUXT_QMS_AUTHORIZE_URL，如 http://<IP>/#/identity/authorize
      clientId: 'fulfillment', // NUXT_QMS_CLIENT_ID
      clientSecret: '', // NUXT_QMS_CLIENT_SECRET
      callbackUrl: '', // NUXT_QMS_CALLBACK_URL，必须 https
      syncEnabled: '1', // NUXT_QMS_SYNC_ENABLED，0 = 关闭 QMS 数据同步（sync-qms）；同步复用上面的 apiBase 与客户端凭据
    },
  },

  // 后台任务：
  //   sync-qms 每 5 分钟（server/tasks/sync-qms.ts）：按游标增量同步 QMS 6 类资源 → 返厂匹配 → QMS 不合格转异常
  //   scan-rules 每 15 分钟（server/tasks/scan-rules.ts）：QMS 不合格转异常（兜底）、W1–W4 扫描、每日汇总
  nitro: {
    experimental: { tasks: true },
    scheduledTasks: { '*/5 * * * *': ['sync-qms'], '*/15 * * * *': ['scan-rules'] },
  },

  app: {
    head: {
      title: '项目履约',
      htmlAttrs: { lang: 'zh-CN' },
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' }],
      link: [
        { rel: 'icon', href: '/favicon.ico', sizes: '16x16 32x32 48x48' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      ],
    },
  },

  devServer: {
    port: 3100,
    // 本地 https://localhost:3100，证书由 pnpm cert:local（mkcert）生成；没有证书时退回 http
    ...(process.env.DEV_HTTPS_KEY && process.env.DEV_HTTPS_CERT
      ? { https: { key: process.env.DEV_HTTPS_KEY, cert: process.env.DEV_HTTPS_CERT } }
      : {}),
  },
})
