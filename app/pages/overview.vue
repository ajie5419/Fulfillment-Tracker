<script setup lang="ts">
/**
 * 旧领导总览地址保留查询参数和锚点；/board 按 can.overview 决定默认视图并校验显式 view。
 */
definePageMeta({
  middleware: (to) => navigateTo({ path: '/board', query: to.query, hash: to.hash }, { replace: true }),
})
</script>

<template>
  <div />
</template>
