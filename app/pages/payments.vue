<script setup lang="ts">
/**
 * 付款申请（R10）：项目和财务看。按影响排序：卡交期的在前，再按离需求日最近。
 * 财务（设置页"人员与角色"里的 财务）或管理员标记 已付 / 暂缓 / 待付，可写一句处理意见；不做审批。
 * 金额只给财务、采购部、领导、项目部负责人、管理员、该工单项目经理看（接口里其他人的金额是 null，显示"—"）。
 * 申请付款：采购部、该工单项目经理、管理员。
 * 前端改版第二轮：顶部统计卡（待付 / 暂缓 / 卡交期未付 / 已付，点了套用状态筛选；数字来自 GET /api/payments/stats，与列表同一范围、
 * 同一口径，不受状态筛选影响）；列表默认按工单分组（?layout=group|table），组标题带本组已付完成度。
 */
import { factoryDateTimeText, groupByWorkOrder, groupProgress } from '#shared/workbench'

const route = useRoute()
const router = useRouter()
const { data: workOrders } = await useWorkOrders()
const { data: me } = await useMe()

const filter = reactive({
  status: (route.query.status as string) || 'UNPAID',
  workOrderNumber: (route.query.wo as string) || undefined,
  /** 只看卡交期的（统计卡"卡交期未付"） */
  blocking: route.query.blocking === '1' ? '1' : undefined,
})
watch(
  () => [filter.status, filter.workOrderNumber, filter.blocking],
  () => router.replace({ query: { ...route.query, status: filter.status, wo: filter.workOrderNumber || undefined, blocking: filter.blocking } }),
)
type PaymentRow = {
  id: string
  workOrderNumber: string
  amount: number | null
  requestDate: string
  blocksDelivery: boolean
  status: PaymentStatusKey
  statusText: string
  note: string | null
  financeNote: string | null
  requesterName: string
  statusByName: string | null
  statusAt: string | null
  nearestNeedDate: string | null
  suppliers: string[]
  lines: { id: string; materialName: string; spec: string | null; needDate: string; status: string; progressText: string }[]
  permissions: { setStatus: boolean; delete: boolean }
}
const { data, pending, refresh } = await useFetch('/api/payments', {
  query: computed(() => ({ status: filter.status, workOrderNumber: filter.workOrderNumber, blocking: filter.blocking })),
  default: () => [],
})
const rows = computed(() => data.value as unknown as PaymentRow[])
const { data: stats, refresh: refreshStats } = await useFetch('/api/payments/stats', {
  query: computed(() => ({ workOrderNumber: filter.workOrderNumber })),
  default: () => null,
})
async function refreshAll() {
  await Promise.all([refresh(), refreshStats()])
}

// ───── 统计卡、按工单分组 ─────
/** 点统计卡：套用状态筛选（卡交期未付 = 未付 + 只看卡交期）；再点一次回到"未付" */
function applyStatus(status: string, blocking?: '1') {
  const same = filter.status === status && filter.blocking === blocking
  filter.status = same ? 'UNPAID' : status
  filter.blocking = same ? undefined : blocking
}
const layout = useListLayout()
const tables = computed(() =>
  layout.value === 'group' ? groupByWorkOrder(rows.value).map((g) => ({ key: g.workOrderNumber, ...g })) : [{ key: '__all', workOrderNumber: '', rows: rows.value }],
)
const paidOf = (g: { rows: PaymentRow[] }) => groupProgress(g.rows, (r) => r.status === 'PAID')
const canSetStatus = computed(() => !!me.value?.isAdmin || !!me.value?.roles.includes('FINANCE'))
const totals = computed(() => {
  const unpaid = rows.value.filter((r) => r.status !== 'PAID')
  return {
    count: unpaid.length,
    blocking: unpaid.filter((r) => r.blocksDelivery).length,
    amount: unpaid.reduce((n, r) => n + (r.amount ?? 0), 0),
    // 有看不到金额的行时不显示合计，免得合计少算
    amountHidden: unpaid.some((r) => r.amount == null),
  }
})

const creating = ref(false)

// ───── 财务改状态 ─────
const acting = ref<{ row: PaymentRow; status: PaymentStatusKey } | null>(null)
const financeNote = ref('')
function openStatus(row: PaymentRow, status: PaymentStatusKey) {
  acting.value = { row, status }
  financeNote.value = row.financeNote ?? ''
}
const busy = ref(false)
async function submitStatus() {
  const a = acting.value
  if (!a) return
  busy.value = true
  try {
    await purchaseSend(`/api/payments/${a.row.id}/status`, 'POST', { status: a.status, note: financeNote.value.trim() || null })
    message.success(`已标记为${PAYMENT_STATUS_TEXT[a.status]}`)
    acting.value = null
    await refreshAll()
  } catch (e) {
    message.error(apiError(e))
  } finally {
    busy.value = false
  }
}

function remove(row: PaymentRow) {
  Modal.confirm({
    title: '删除这张付款申请？',
    okText: '删除',
    okType: 'danger',
    async onOk() {
      try {
        await purchaseSend(`/api/payments/${row.id}`, 'DELETE')
        message.success('已删除')
        await refreshAll()
      } catch (e) {
        message.error(apiError(e))
      }
    },
  })
}

const statusOptions = [
  { value: 'UNPAID', label: '未付' },
  { value: 'PENDING', label: '待付' },
  { value: 'ON_HOLD', label: '暂缓' },
  { value: 'PAID', label: '已付' },
  { value: 'ALL', label: '全部' },
]
const columns = [
  { title: '', key: 'blocks', width: 70 },
  { title: '工单', key: 'wo', width: 130 },
  { title: '物料', key: 'lines' },
  { title: '供应商', key: 'suppliers', width: 150 },
  { title: '最近需求日', key: 'need', width: 110 },
  { title: '金额（元）', key: 'amount', width: 130, align: 'right' as const },
  { title: '申请', key: 'request', width: 130 },
  { title: '状态', key: 'status', width: 170 },
  { title: '', key: 'actions', width: 200 },
]
const groupColumns = columns.filter((c) => c.key !== 'wo')
</script>

<template>
  <div class="ft-page">
  <div v-if="stats" class="ft-stats">
    <UiStatCard label="待付" :value="stats.pending" unit="笔" tone="primary" accent icon="dot" clickable :active="filter.status === 'PENDING' && !filter.blocking" sub="财务还没处理的" @click="applyStatus('PENDING')" />
    <UiStatCard label="卡交期未付" :value="stats.blockingUnpaid" unit="笔" tone="late" accent icon="alert" clickable :active="filter.status === 'UNPAID' && filter.blocking === '1'" sub="待付 + 暂缓里卡交期的" @click="applyStatus('UNPAID', '1')" />
    <UiStatCard label="暂缓" :value="stats.onHold" unit="笔" tone="risk" accent icon="warn" clickable :active="filter.status === 'ON_HOLD' && !filter.blocking" @click="applyStatus('ON_HOLD')" />
    <UiStatCard label="已付" :value="stats.paid" unit="笔" tone="done" accent icon="check" clickable :active="filter.status === 'PAID' && !filter.blocking" @click="applyStatus('PAID')" />
  </div>
  <a-card>
    <template #title>
      <span class="ft-title">付款申请
        <UiHelpTip label="付款申请说明">"未付"包括待付和暂缓。排序：卡交期的在前，再按关联物料里离需求日最近的。不做审批：{{ canSetStatus ? '你可以直接标记 已付 / 暂缓。' : '财务标记 已付 / 暂缓（财务在设置页"人员与角色"里配置）。' }}</UiHelpTip>
      </span>
    </template>
    <template #extra>
      <a-space wrap>
        <a-select
          v-model:value="filter.workOrderNumber"
          allow-clear
          show-search
          placeholder="全部工单"
          style="width: 170px"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: w.workOrderNumber }))"
        />
        <UiRefreshButton @click="refreshAll()" />
        <a-button v-if="canDoAny(me, 'payment')" type="primary" @click="creating = true">申请付款</a-button>
      </a-space>
    </template>
    <div class="ft-toolbar">
      <a-segmented v-model:value="filter.status" :options="statusOptions" />
      <div class="ft-toolbar-right">
        <a-tag v-if="filter.blocking" color="red" closable @close="filter.blocking = undefined">只看卡交期</a-tag>
        <a-segmented v-model:value="layout" :options="LAYOUT_OPTIONS" />
      </div>
    </div>
    <a-space size="large" class="totals">
      <span>未付 <b>{{ totals.count }}</b> 笔</span>
      <span :class="{ warn: totals.blocking }">其中卡交期 <b>{{ totals.blocking }}</b> 笔</span>
      <span v-if="!totals.amountHidden">未付金额 <b>{{ moneyText(totals.amount) }}</b> 元</span>
    </a-space>
    <a-spin v-if="layout === 'group' && !rows.length" :spinning="pending"><a-empty description="没有付款申请" /></a-spin>
    <div v-for="t in tables" :key="t.key" :class="{ 'ft-wo-group': layout === 'group' }">
    <UiWoGroupHead v-if="layout === 'group'" :no="t.workOrderNumber" v-bind="paidOf(t)" label="已付" :count="t.rows.length" unit="笔" />
    <a-table
      :columns="layout === 'group' ? groupColumns : columns"
      :data-source="t.rows"
      :loading="pending"
      row-key="id"
      size="small"
      :scroll="{ x: 1000 }"
      :pagination="layout === 'group' ? false : { pageSize: 50, hideOnSinglePage: true }"
    >
      <template #emptyText><a-empty description="没有付款申请" /></template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'blocks'">
          <a-tag v-if="record.blocksDelivery" color="red">卡交期</a-tag>
        </template>
        <template v-else-if="column.key === 'wo'"><WoLink :no="record.workOrderNumber" /></template>
        <template v-else-if="column.key === 'lines'">
          <div v-for="l in record.lines" :key="l.id" class="line">
            <NuxtLink :to="`/purchases?id=${encodeURIComponent(l.id)}`">{{ l.materialName }}</NuxtLink>
            <span v-if="l.spec" class="muted">（{{ l.spec }}）</span>
            <a-tag :color="PURCHASE_PROGRESS_COLOR[l.progressText]" class="small-tag">{{ l.progressText }}</a-tag>
          </div>
          <div v-if="record.note" class="muted">{{ record.note }}</div>
        </template>
        <template v-else-if="column.key === 'suppliers'">{{ record.suppliers.join('、') || '—' }}</template>
        <template v-else-if="column.key === 'need'">
          <span v-if="record.nearestNeedDate">{{ dayText(record.nearestNeedDate) }}</span>
          <span v-else class="muted">都已到货</span>
        </template>
        <template v-else-if="column.key === 'amount'">{{ moneyText(record.amount) }}</template>
        <template v-else-if="column.key === 'request'">
          {{ dayText(record.requestDate) }}
          <div class="muted">{{ record.requesterName }}</div>
        </template>
        <template v-else-if="column.key === 'status'">
          <a-tag :color="PAYMENT_STATUS_COLOR[record.status as PaymentStatusKey]">{{ record.statusText }}</a-tag>
          <div v-if="record.statusByName" class="muted">{{ record.statusByName }} {{ factoryDateTimeText(record.statusAt) }}</div>
          <div v-if="record.financeNote" class="muted">{{ record.financeNote }}</div>
        </template>
        <template v-else-if="column.key === 'actions'">
          <a-space size="small" wrap>
            <template v-if="record.permissions.setStatus">
              <a-button v-if="record.status !== 'PAID'" type="primary" size="small" @click="openStatus(record as PaymentRow, 'PAID')">标记已付</a-button>
              <a-button v-if="record.status === 'PENDING'" size="small" @click="openStatus(record as PaymentRow, 'ON_HOLD')">暂缓</a-button>
              <a-button v-if="record.status !== 'PENDING'" size="small" @click="openStatus(record as PaymentRow, 'PENDING')">改回待付</a-button>
            </template>
            <a-button v-if="record.permissions.delete" size="small" danger @click="remove(record as PaymentRow)">删除</a-button>
          </a-space>
        </template>
      </template>
    </a-table>
    </div>
  </a-card>
  </div>

  <PaymentCreateModal :open="creating" @close="creating = false" @done="creating = false; refreshAll()" />

  <a-modal :open="!!acting" :title="acting ? `标记为${PAYMENT_STATUS_TEXT[acting.status]}` : ''" ok-text="确定" :confirm-loading="busy" @ok="submitStatus" @cancel="acting = null">
    <p v-if="acting">{{ acting.row.workOrderNumber }} · {{ acting.row.lines.map((l) => l.materialName).join('、') }} · {{ moneyWithUnit(acting.row.amount) }}</p>
    <a-input v-model:value="financeNote" :maxlength="500" placeholder="处理意见，可空（如：月底统一付）" />
  </a-modal>
</template>

<style scoped>
.totals { margin-bottom: 8px; }
.muted { color: var(--ft-text-2); font-size: 12px; }
.warn { color: var(--ft-late); }
.line { line-height: 22px; }
.small-tag { margin-left: 6px; font-size: 11px; line-height: 16px; }
</style>
