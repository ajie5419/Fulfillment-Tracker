<script setup lang="ts">
/** 旧地址：待确认匹配（生产管理重设计后放进外协页"待确认匹配"页签），重定向过去 */
definePageMeta({
  middleware: () => navigateTo({ path: '/outsource', query: { tab: 'match' } }, { replace: true }),
})
</script>

<template>
  <div />
</template>
