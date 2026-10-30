<script setup lang="ts">
/**
 * 旧地址：领导总览（功能重复梳理第一批：并入项目总览，领导、项目部负责人、管理员在项目总览上方看到原领导总览独有的几块）。
 * 旧链接、书签跳到项目总览，不丢。
 * 状态监控也放在项目总览的管理视图区（StatusMonitoringPanel），沿用此跳转，不恢复重复页面。
 */
definePageMeta({
  middleware: () => navigateTo({ path: '/board' }, { replace: true }),
})
</script>

<template>
  <div />
</template>
