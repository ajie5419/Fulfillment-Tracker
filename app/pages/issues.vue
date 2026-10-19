<script setup lang="ts">
/**
 * 旧地址：异常列表（前端改版第二轮并入风险页）。
 * 系统里已有的链接（提醒里的"异常"、预警转出的异常、工件页的异常编号、项目总览 / 工单详情 / 领导总览的数字）都指向这里，
 * 原样带上地址栏参数（?id= ?status= ?category= ?wo= ?dept= ?mine= ?overdue=）重定向到 /risks?tab=issues，筛选和打开的异常与原来一致。
 */
definePageMeta({
  middleware: (to) => navigateTo({ path: '/risks', query: { ...to.query, tab: 'issues' }, hash: to.hash }, { replace: true }),
})
</script>

<template>
  <div />
</template>
