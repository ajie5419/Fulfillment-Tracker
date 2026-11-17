<script setup lang="ts">
import type { PlanData } from '../composables/usePlanData'
import { PLAN_CHANGE_KIND as LOG_KIND } from '#shared/plan-validation'

/** 总计划发布后的调整记录表（PlanEditor 拆分，只读展示）。 */
defineProps<{ logs: PlanData['changeLogs'] }>()

const logColumns = [
  { title: '时间', key: 'createdAt', width: 160 },
  { title: '节点', dataIndex: 'nodeName', width: 160 },
  { title: '调整', key: 'change', width: 260 },
  { title: '原因', dataIndex: 'reason' },
  { title: '操作人', dataIndex: 'actorName', width: 100 },
]
</script>

<template>
  <UiSectionCard tray padding="none" title="调整记录（发布后）" class="log-card">
    <a-table class="ft-table" :columns="logColumns" :data-source="logs" row-key="id" size="small" :pagination="{ pageSize: 10, hideOnSinglePage: true }">
      <template #emptyText><p class="muted-empty">没有调整</p></template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'createdAt'">{{ timeText(record.createdAt) }}</template>
        <template v-else-if="column.key === 'change'">
          <a-tag>{{ LOG_KIND[record.kind as keyof typeof LOG_KIND] }}</a-tag>
          <template v-if="record.kind === 'DATE' || record.kind === 'START'">{{ record.oldDate ?? '未设置' }} → {{ record.newDate ?? '未设置' }}</template>
          <template v-else-if="record.kind === 'ADD'">计划 {{ record.newDate }}</template>
          <template v-else>原计划 {{ record.oldDate }}</template>
        </template>
      </template>
    </a-table>
  </UiSectionCard>
</template>

<style scoped>
.log-card { margin-top: 16px; }
.muted-empty { margin: 12px 0; color: var(--ft-text-3); font-size: 12.5px; }
</style>
