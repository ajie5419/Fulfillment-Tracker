<script setup lang="ts">
/**
 * 旧地址：预警列表（前端改版第二轮并入风险页）。
 * 系统里已有的链接（提醒、预警弹窗、项目总览 / 工单详情的数字、领导总览的"外协超期未返"）都指向这里，
 * 原样带上地址栏参数（?rule= ?level= ?wo=）重定向到 /risks?tab=alerts，筛选结果与原来一致。
 */
definePageMeta({
  middleware: (to) => navigateTo({ path: '/risks', query: { ...to.query, tab: 'alerts' }, hash: to.hash }, { replace: true }),
})
</script>

<template>
  <div />
</template>
