<script setup lang="ts">
/**
 * 待确认匹配：没能自动匹配的返厂报检，从候选里选一个点"关联"，或点"忽略"。
 * 关联 / 忽略：生产部、外协专员、该工单项目经理、管理员（权限方案 R13），其他人只读。
 */
const { data: rows, pending, refresh } = await useFetch('/api/unmatched', { default: () => [] })
type Row = (typeof rows.value)[number]
const { data: me } = await useMe()
const canHandle = (r: Row) => canDo(me.value, 'route', { workOrderNumber: r.inspection?.workOrderNumber })
const chosen = reactive<Record<string, string | undefined>>({})

watch(rows, (list) => {
  for (const r of list) if (!chosen[r.qmsInspectionId] && r.candidates.length === 1) chosen[r.qmsInspectionId] = r.candidates[0]!.stepId
}, { immediate: true })

async function act(r: Pick<Row, 'qmsInspectionId'>, kind: 'resolve' | 'ignore') {
  const stepId = chosen[r.qmsInspectionId]
  if (kind === 'resolve' && !stepId) return message.warning('请先选择要关联的步骤')
  try {
    await $fetch(`/api/unmatched/${encodeURIComponent(r.qmsInspectionId)}/${kind}`, {
      method: 'POST',
      body: kind === 'resolve' ? { stepId } : {},
    })
    message.success(kind === 'resolve' ? '已关联，步骤已按返厂处理' : '已忽略')
    await refresh()
  } catch (e) {
    message.error(apiError(e))
  }
}

const columns = [
  { title: '报检', key: 'inspection', width: 220 },
  { title: '物料', key: 'part' },
  { title: '工序 / 外协厂', key: 'process' },
  { title: '数量', key: 'qty', width: 64 },
  { title: '原因', key: 'reason', width: 170 },
  { title: '关联到', key: 'choose', width: 340 },
  { title: '', key: 'actions', width: 150 },
]
const reasonColor = { NO_CANDIDATE: 'orange', MULTIPLE: 'blue', CANCELLED_AFTER_MATCH: 'red' } as const
</script>

<template>
  <a-card title="待确认匹配" :loading="pending">
    <template #extra><a-button size="small" @click="refresh()">刷新</a-button></template>
    <a-empty v-if="!rows.length" description="没有需要确认的报检" />
    <a-table v-else :columns="columns" :data-source="rows" row-key="qmsInspectionId" size="small" :pagination="false">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'inspection'">
          <div>{{ record.inspection?.requestNo ?? record.qmsInspectionId }}</div>
          <div class="muted">{{ record.inspection?.workOrderNumber }}　{{ timeText(record.inspection?.submittedAt) }}</div>
          <a-tag v-if="record.inspection?.status === 'CANCELLED'" color="red">QMS 已撤销</a-tag>
        </template>
        <template v-else-if="column.key === 'part'">
          {{ record.inspection?.partName || '—' }}
          <div class="muted">物料 ID {{ record.inspection?.partId || '—' }}</div>
        </template>
        <template v-else-if="column.key === 'process'">
          {{ record.inspection?.processName || '—' }}
          <div class="muted">{{ record.inspection?.supplierName || record.inspection?.supplierId || '未填外协厂' }}</div>
        </template>
        <template v-else-if="column.key === 'qty'">{{ record.inspection?.quantity }}</template>
        <template v-else-if="column.key === 'reason'">
          <a-tag :color="reasonColor[record.reason as keyof typeof reasonColor]">{{ REASON_TEXT[record.reason as keyof typeof REASON_TEXT] ?? record.reason }}</a-tag>
        </template>
        <template v-else-if="column.key === 'choose'">
          <span v-if="record.reason === 'CANCELLED_AFTER_MATCH'" class="muted">已按返厂处理过，步骤不回退；请人工核实后点"知道了"</span>
          <span v-else-if="!record.candidates.length" class="muted">该工单下没有在外的外协步骤</span>
          <a-select
            v-else
            v-model:value="chosen[record.qmsInspectionId]"
            style="width: 100%"
            placeholder="选择工件步骤"
            :options="record.candidates.map((c: Row['candidates'][number]) => ({ value: c.stepId, label: `${c.partName} · ${c.processName}（${c.supplierName ?? '无外协厂'}，${STATUS_TEXT[c.status]}）` }))"
          />
        </template>
        <template v-else-if="column.key === 'actions'">
          <span v-if="!canHandle(record as Row)" class="muted">—</span>
          <a-space v-else>
            <a-button v-if="record.reason !== 'CANCELLED_AFTER_MATCH'" type="primary" size="small" :disabled="!record.candidates.length" @click="act(record as Row, 'resolve')">关联</a-button>
            <a-button size="small" @click="act(record as Row, 'ignore')">{{ record.reason === 'CANCELLED_AFTER_MATCH' ? '知道了' : '忽略' }}</a-button>
          </a-space>
        </template>
      </template>
    </a-table>
  </a-card>
</template>

<style scoped>
.muted { color: #999; font-size: 12px; }
</style>
