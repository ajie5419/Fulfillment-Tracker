<script setup lang="ts">
import { MONITORING_ENTITY_TEXT, MONITORING_LEVEL_TEXT, MONITORING_TONE } from '#shared/monitoring'
import { factoryDateTimeText } from '#shared/workbench'
import type { MonitoredEntity } from '#shared/monitoring'

type Row = Omit<MonitoredEntity, 'since'> & { since: string | Date }
defineProps<{ rows: Row[] }>()
const responsibility = (row: Row) => [...row.deptNames, ...row.owners.map((o) => o.name).filter(Boolean)].join(' · ') || '—'
</script>

<template>
  <div class="ft-well list monitoring-list">
    <UiListItem v-for="row in rows" :key="`${row.entityType}:${row.id}`" :tone="MONITORING_TONE[row.level]">
      <template #title><NuxtLink :to="row.link">{{ row.name }}</NuxtLink><span class="ft-muted">{{ MONITORING_ENTITY_TEXT[row.entityType] }}</span></template>
      <template #desc>{{ row.drawingNo || '无图号' }} · <WoLink :no="row.workOrderNumber" /> · {{ row.statusText }}</template>
      <template #meta>进入状态 {{ factoryDateTimeText(row.since) }} · 责任方：{{ responsibility(row) }}</template>
      <template #extra><UiStatusTag :tone="MONITORING_TONE[row.level]">{{ MONITORING_LEVEL_TEXT[row.level] }} · {{ row.days }} 天</UiStatusTag></template>
    </UiListItem>
    <p v-if="!rows.length" class="ft-muted">暂无符合条件的在制对象</p>
  </div>
</template>

<style scoped>
.monitoring-list { overflow-wrap: anywhere; }
@media (max-width: 575px) {
  .monitoring-list :deep(.ft-li) { flex-wrap: wrap; }
  .monitoring-list :deep(.main) { flex: 1 0 calc(100% - 48px); }
  .monitoring-list :deep(.extra) { margin-left: 48px; }
}
</style>
