<script setup lang="ts">
/**
 * 旧地址：工单详情入口（选工单）（功能重复梳理第一批：去掉，改在项目总览顶部搜工单；详情页 /wo/:no 不变）。
 * 旧链接、书签跳到项目总览，不丢。
 */
definePageMeta({
  middleware: () => navigateTo({ path: '/board' }, { replace: true }),
})
</script>

<template>
  <div />
</template>
