<script setup lang="ts">
const { data, error, refresh } = useApiFetch('/api/board-sync')
const description = computed(() => data.value?.map(row => `${row.label}（连续失败 ${row.failCount} 次）：${row.lastError}`).join('；'))
defineExpose({ refresh })
</script>

<template>
  <a-alert v-if="error" type="warning" show-icon message="暂时无法读取 QMS 同步状态"><template #action><a-button size="small" @click="refresh()">重试</a-button></template></a-alert>
  <a-alert v-else-if="description" type="error" show-icon message="QMS 同步出错，数据可能不是最新" :description="description" />
</template>

<style scoped>
.ant-alert { margin-bottom:12px; }
</style>
