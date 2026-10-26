<script setup lang="ts">
/** 旧地址：手机"外协在途"（生产管理重设计后并入"生产"页签的"在外"），带上 ?wo= 重定向过去，切到"全部" */
definePageMeta({
  layout: 'mobile',
  middleware: (to) => navigateTo({ path: '/m/work', query: { ...to.query, seg: 'out', mine: '0' } }, { replace: true }),
})
</script>

<template>
  <div />
</template>
