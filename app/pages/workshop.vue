<script setup lang="ts">
/**
 * 旧地址：车间看板（生产管理重设计后成为"生产调度"的看板视图）。
 * 原参数 ?wo= ?supplierId= 原样带过去，并切到看板视图。
 */
definePageMeta({
  middleware: (to) => navigateTo({ path: '/production', query: { ...to.query, view: 'board' } }, { replace: true }),
})
</script>

<template>
  <div />
</template>
