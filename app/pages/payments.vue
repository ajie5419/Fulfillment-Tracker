<script setup lang="ts">
/**
 * 付款申请（R10）：项目和财务看。按影响排序：卡交期的在前，再按离需求日最近。
 * 财务（设置页"人员与角色"里的 财务）或管理员标记 已付 / 暂缓 / 待付，可写一句处理意见；不做审批。
 * 金额只给财务、采购部、领导、项目部负责人、管理员、该工单项目经理看（接口里其他人的金额是 null，显示"—"）。
 * 申请付款：采购部、该工单项目经理、管理员。
 */
const route = useRoute()
const { data: workOrders } = await useWorkOrders()
const { data: me } = await useMe()

const filter = reactive({
  status: (route.query.status as string) || 'UNPAID',
  workOrderNumber: (route.query.wo as string) || undefined,
})
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
  query: computed(() => ({ ...filter })),
  default: () => [],
})
const rows = computed(() => data.value as unknown as PaymentRow[])
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
    await refresh()
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
        await refresh()
      } catch (e) {
        message.error(apiError(e))
      }
    },
  })
}

const statusOptions = [
  { value: 'UNPAID', label: '未付（待付 + 暂缓）' },
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
</script>

<template>
  <a-card title="付款申请">
    <template #extra>
      <a-space wrap>
        <a-select v-model:value="filter.status" style="width: 170px" :options="statusOptions" />
        <a-select
          v-model:value="filter.workOrderNumber"
          allow-clear
          show-search
          placeholder="全部工单"
          style="width: 170px"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: w.workOrderNumber }))"
        />
        <a-button @click="refresh()">刷新</a-button>
        <a-button v-if="canDoAny(me, 'payment')" type="primary" @click="creating = true">申请付款</a-button>
      </a-space>
    </template>
    <a-space size="large" class="totals">
      <span>未付 <b>{{ totals.count }}</b> 笔</span>
      <span :class="{ warn: totals.blocking }">其中卡交期 <b>{{ totals.blocking }}</b> 笔</span>
      <span v-if="!totals.amountHidden">未付金额 <b>{{ moneyText(totals.amount) }}</b> 元</span>
    </a-space>
    <p class="muted">
      排序：卡交期的在前，再按关联物料里离需求日最近的。不做审批：{{ canSetStatus ? '你可以直接标记 已付 / 暂缓。' : '财务标记 已付 / 暂缓（财务在设置页"人员与角色"里配置）。' }}
    </p>
    <a-table :columns="columns" :data-source="rows" :loading="pending" row-key="id" size="small" :pagination="{ pageSize: 50, hideOnSinglePage: true }">
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
          <div v-if="record.statusByName" class="muted">{{ record.statusByName }} {{ timeText(record.statusAt) }}</div>
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
  </a-card>

  <PaymentCreateModal :open="creating" @close="creating = false" @done="creating = false; refresh()" />

  <a-modal :open="!!acting" :title="acting ? `标记为${PAYMENT_STATUS_TEXT[acting.status]}` : ''" ok-text="确定" :confirm-loading="busy" @ok="submitStatus" @cancel="acting = null">
    <p v-if="acting">{{ acting.row.workOrderNumber }} · {{ acting.row.lines.map((l) => l.materialName).join('、') }} · {{ moneyWithUnit(acting.row.amount) }}</p>
    <a-input v-model:value="financeNote" :maxlength="500" placeholder="处理意见，可空（如：月底统一付）" />
  </a-modal>
</template>

<style scoped>
.totals { margin-bottom: 8px; }
.muted { color: #999; font-size: 12px; }
.warn { color: var(--ft-late); }
.line { line-height: 22px; }
.small-tag { margin-left: 6px; font-size: 11px; line-height: 16px; }
</style>
