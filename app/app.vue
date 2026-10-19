<script setup lang="ts">
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import { STATUS_COLOR } from '#shared/status'

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
    colorTextBase: '#1b2430',
    borderRadius: 8,
    borderRadiusLG: 14,
    borderRadiusSM: 6,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
}
</script>

<template>
  <!-- AExtractStyle：服务端渲染时把 Ant Design Vue 的样式内联到首屏 HTML -->
  <AExtractStyle>
    <AConfigProvider :locale="zhCN" :theme="theme">
      <NuxtLayout>
        <NuxtPage />
      </NuxtLayout>
    </AConfigProvider>
  </AExtractStyle>
</template>
