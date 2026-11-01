<script setup lang="ts">
import type { PlanData } from '../composables/usePlanData'

/** 总计划发布后的调整记录表（PlanEditor 拆分，只读展示）。 */
defineProps<{ logs: PlanData['changeLogs'] }>()

const LOG_KIND = { DATE: '改日期', ADD: '加节点', DELETE: '删节点' } as const
const logColumns = [
  { title: '时间', key: 'createdAt', width: 160 },
  { title: '节点', dataIndex: 'nodeName', width: 160 },
  { title: '调整', key: 'change', width: 260 },
  { title: '原因', dataIndex: 'reason' },
  { title: '操作人', dataIndex: 'actorName', width: 100 },
]
</script>

<template>
  <h4 class="section">调整记录（发布后）</h4>
  <a-table :columns="logColumns" :data-source="logs" row-key="id" size="small" :pagination="{ pageSize: 10, hideOnSinglePage: true }">
    <template #emptyText><a-empty description="没有调整" /></template>
    <template #bodyCell="{ column, record }">
      <template v-if="column.key === 'createdAt'">{{ timeText(record.createdAt) }}</template>
      <template v-else-if="column.key === 'change'">
        <a-tag>{{ LOG_KIND[record.kind as keyof typeof LOG_KIND] }}</a-tag>
        <template v-if="record.kind === 'DATE'">{{ record.oldDate }} → {{ record.newDate }}</template>
        <template v-else-if="record.kind === 'ADD'">计划 {{ record.newDate }}</template>
        <template v-else>原计划 {{ record.oldDate }}</template>
      </template>
    </template>
  </a-table>
</template>

<style scoped>
.section { margin: 20px 0 8px; }
</style>
