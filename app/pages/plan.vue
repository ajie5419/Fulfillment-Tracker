<script setup lang="ts">
/**
 * 旧地址：总计划（功能重复梳理第二批并入工单详情的"总计划"页签）。
 * 提醒、待办、W9 通知里存的链接都是 /plan?wo=&node=，原样带参数跳到 /wo/:no?tab=plan&node=，定位不丢；没带工单的跳项目总览。
 */
definePageMeta({
  middleware: (to) => {
    const wo = typeof to.query.wo === 'string' ? to.query.wo : ''
    if (!wo) return navigateTo('/board', { replace: true })
    const node = typeof to.query.node === 'string' ? to.query.node : undefined
    return navigateTo({ path: `/wo/${encodeURIComponent(wo)}`, query: { tab: 'plan', node } }, { replace: true })
  },
})
</script>

<template>
  <div />
</template>
