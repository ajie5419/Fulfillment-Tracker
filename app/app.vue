<script setup lang="ts">
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import { STATUS_COLOR } from '#shared/status'
import { THEME_COLOR } from '#shared/theme'

// Nuxt Suspense resolves async page setup before replacing the previous page.
// Hide that previous content as soon as navigation starts.
const changingPage = useState('page-changing', () => false)
const nuxtApp = useNuxtApp()
const router = useRouter()
router.beforeEach((to, from) => { if (to.path !== from.path) changingPage.value = true })
nuxtApp.hook('page:finish', () => { changingPage.value = false })
router.afterEach((_to, _from, failure) => { if (failure) changingPage.value = false })
nuxtApp.hook('app:error', () => { changingPage.value = false })

// 日期选择器、分页等组件的文案用中文
dayjs.locale('zh-cn')

// 全站主题（前端改版第一轮）：主色、圆角、字体、状态色；状态色与 shared/status.ts、assets/base.css 一致
const theme = {
  token: {
    colorPrimary: STATUS_COLOR.onTrack,
    colorSuccess: STATUS_COLOR.done,
    colorWarning: STATUS_COLOR.risk,
    colorError: STATUS_COLOR.late,
    colorInfo: STATUS_COLOR.onTrack,
    colorTextBase: THEME_COLOR.textBase,
    colorBorder: THEME_COLOR.border,
    // 大圆角与 base.css 的 --card-radius-outer 对齐。
    borderRadius: 10,
    borderRadiusLG: 16,
    borderRadiusSM: 8,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
}
</script>

<template>
  <!-- AExtractStyle：服务端渲染时把 Ant Design Vue 的样式内联到首屏 HTML -->
  <AExtractStyle>
    <AConfigProvider :locale="zhCN" :theme="theme">
      <NuxtLayout>
        <div v-if="changingPage" role="status" class="ft-page">正在加载…</div>
        <div v-show="!changingPage"><NuxtPage :page-key="route => route.path" /></div>
      </NuxtLayout>
    </AConfigProvider>
  </AExtractStyle>
</template>
