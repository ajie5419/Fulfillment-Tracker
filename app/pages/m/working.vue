<script setup lang="ts">
/** 旧地址：手机"加工中"（生产管理重设计后并入"生产"页签的"在做"），带上 ?stepId= 重定向过去 */
definePageMeta({
  layout: 'mobile',
  middleware: (to) => navigateTo({ path: '/m/work', query: { ...to.query, seg: 'working', ...(to.query.stepId ? {} : { mine: to.query.mine }) } }, { replace: true }),
})
</script>

<template>
  <div />
</template>
