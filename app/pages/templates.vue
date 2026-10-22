<script setup lang="ts">
/**
 * 旧地址：工序路线模板（功能重复梳理第一批并入"设置 → 工序路线模板"页签）。
 * 演示工具、旧书签里的 /templates 跳到这里，不丢。
 */
definePageMeta({
  middleware: () => navigateTo({ path: '/settings', query: { tab: 'route-templates' } }, { replace: true }),
})
</script>

<template>
  <div />
</template>
