<script setup lang="ts">
const { data: me } = await useMe()
const syncNotice = ref<{ refresh: () => unknown } | null>(null)
const activePanel = ref<{ refresh: () => unknown } | null>(null)
async function refreshAll() { await Promise.all([syncNotice.value?.refresh(), activePanel.value?.refresh()]) }
</script>
<template>
  <div class="page">
    <BoardSyncNotice ref="syncNotice" />
    <BoardOrderDirectory ref="activePanel" :show-refresh="!me?.can.workOrder" @refresh="refreshAll()" />
  </div>
</template>
