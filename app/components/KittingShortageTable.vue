<script setup lang="ts">
/** 缺件清单（R12）：一个节点缺的工件和关键物料，以及各自卡在哪一步 */
withDefaults(defineProps<{ shortages: KitShortage[]; emptyText?: string }>(), { emptyText: '不缺件' })
const columns = [
  { title: '类型', key: 'kind', width: 60 },
  { title: '缺件', key: 'name' },
  { title: '当前', key: 'stage', width: 120 },
  { title: '卡在', key: 'reason', width: 220 },
  { title: '承诺 / 需求', key: 'dates', width: 200 },
]
</script>

<template>
  <a-table :columns="columns" :data-source="shortages" :row-key="(r: KitShortage) => `${r.kind}:${r.id}`" size="small" :pagination="false">
    <template #emptyText><span class="muted">{{ emptyText }}</span></template>
    <template #bodyCell="{ column, record }">
      <template v-if="column.key === 'kind'">{{ record.kind === 'part' ? '工件' : '物料' }}</template>
      <template v-else-if="column.key === 'name'">{{ record.name }}</template>
      <template v-else-if="column.key === 'stage'"><span :class="{ muted: !record.stage }">{{ record.stage ?? '—' }}</span></template>
      <template v-else-if="column.key === 'reason'">
        <a-tag :color="BLOCKER_COLOR[record.reasonCode] ?? 'default'">{{ record.reason }}</a-tag>
        <span v-if="record.detail" class="muted">{{ record.detail }}</span>
      </template>
      <template v-else-if="column.key === 'dates'">
        <template v-if="record.kind === 'purchase'">
          <span :class="{ warn: record.lateForNode }">承诺 {{ record.promisedDate ?? '无' }}</span> / 需求 {{ record.needDate }}
          <a-tag v-if="record.overdue" color="red" class="ml">逾期</a-tag>
          <div v-if="record.lateForNode" class="warn small">赶不上节点需求日</div>
        </template>
        <span v-else class="muted">—</span>
      </template>
    </template>
  </a-table>
</template>

<style scoped>
.muted { color: #999; font-size: 12px; }
.warn { color: var(--ft-late-text); }
.small { font-size: 12px; }
.ml { margin-left: 4px; }
</style>
