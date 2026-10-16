<script setup lang="ts">
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'

// 日期选择器、分页等组件的文案用中文
dayjs.locale('zh-cn')
</script>

<template>
  <!-- AExtractStyle：服务端渲染时把 Ant Design Vue 的样式内联到首屏 HTML -->
  <AExtractStyle>
    <AConfigProvider :locale="zhCN">
      <NuxtLayout>
        <NuxtPage />
      </NuxtLayout>
    </AConfigProvider>
  </AExtractStyle>
</template>
