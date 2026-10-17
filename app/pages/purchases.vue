<script setup lang="ts">
/**
 * 采购到货（R10）：关键物料采购行列表、登记 / 编辑、Excel 导入、确认到货、申请付款。
 * 顶部统计：未到货、缺料、无承诺日、卡付款；延误按原因分"付款原因"和"管理原因"。
 * 地址栏 ?wo= 预选工单，?view= 选视图，?id= 打开某一行（预警提醒跳过来）。
 */
const route = useRoute()
const router = useRouter()
const { data: workOrders } = await useWorkOrders()

const VIEWS = [
  { value: 'open', label: '未到货' },
  { value: 'shortage', label: '缺料' },
  { value: 'late', label: '延误' },
  { value: 'arrived', label: '已到货' },
  { value: 'cancelled', label: '已取消' },
  { value: 'all', label: '全部' },
] as const
const filter = reactive({
  workOrderNumber: (route.query.wo as string) || undefined,
  view: VIEWS.some((v) => v.value === route.query.view) ? (route.query.view as string) : route.query.id ? 'all' : 'open',
  q: '',
})
const keyword = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
watch(keyword, (v) => {
  clearTimeout(timer)
  timer = setTimeout(() => (filter.q = v.trim()), 300)
})
watch(
  () => [filter.workOrderNumber, filter.view],
  () => router.replace({ query: { ...route.query, wo: filter.workOrderNumber || undefined, view: filter.view } }),
)

const { data, pending, refresh } = await useFetch('/api/purchases', {
  query: computed(() => ({ workOrderNumber: filter.workOrderNumber, view: filter.view, q: filter.q || undefined })),
  default: () => ({ rows: [] as PurchaseRow[], total: 0, stats: null as PurchaseStats | null }),
})
const rows = computed(() => data.value.rows as PurchaseRow[])
const stats = computed(() => data.value.stats as PurchaseStats | null)

// ───── 新建 / 编辑 ─────
const editing = ref<PurchaseRow | null>(null)
const editOpen = ref(false)
function openEdit(r: PurchaseRow | null) {
  editing.value = r
  editOpen.value = true
}
async function saved() {
  editOpen.value = false
  await refresh()
}
// ?id= 打开该行（从 W6 提醒跳过来）
async function openFromQuery() {
  const id = route.query.id as string | undefined
  if (!id) return
  try {
    openEdit(await fetchPurchase(id))
  } catch (e) {
    message.error(apiError(e))
  }
}
onMounted(openFromQuery)
watch(() => route.query.id, openFromQuery)
function closeEdit() {
  editOpen.value = false
  if (route.query.id) router.replace({ query: { ...route.query, id: undefined } })
}

const importing = ref(false)

// ───── 确认到货 ─────
const arriving = ref<PurchaseRow | null>(null)
const arrival = reactive({ arrivedDate: dayAfter(0), delayReason: undefined as string | undefined, delayNote: '' })
const arrivalLate = computed(() => {
  const r = arriving.value
  if (!r) return false
  const need = dayText(r.needDate)
  const promised = r.promisedDate ? dayText(r.promisedDate) : null
  return arrival.arrivedDate > need || (!!promised && arrival.arrivedDate > promised)
})
function openArrive(r: PurchaseRow) {
  arriving.value = r
  // 有没付的卡交期付款时默认原因"付款"
  Object.assign(arrival, { arrivedDate: dayAfter(0), delayReason: r.delayReason ?? (r.blockedByPayment ? 'PAYMENT' : undefined), delayNote: r.delayNote ?? '' })
}
const busy = ref(false)
async function confirmArrive() {
  const r = arriving.value
  if (!r) return
  busy.value = true
  try {
    const res = await purchaseSend<{ late: boolean; readySent: boolean }>(`/api/purchases/${r.id}/arrive`, 'POST', {
      arrivedDate: arrival.arrivedDate,
      delayReason: arrivalLate.value ? (arrival.delayReason ?? null) : undefined,
      delayNote: arrivalLate.value ? arrival.delayNote.trim() || null : undefined,
      source: 'PC',
    })
    message.success(res.readySent ? '已确认到货；该工件的关键物料已全部到齐，已通知第一道工序"可以开工"' : '已确认到货')
    arriving.value = null
    await refresh()
  } catch (e) {
    message.error(apiError(e))
  } finally {
    busy.value = false
  }
}

function undo(r: PurchaseRow) {
  Modal.confirm({
    title: `撤销到货：${r.materialName}？`,
    content: r.arrivalSource === 'QMS_INSPECTION' ? '这一项是 QMS 进货检验自动确认的，撤销后只能手工确认到货' : '回到未到货，重新计算缺料和预警',
    okText: '撤销',
    async onOk() {
      try {
        await purchaseSend(`/api/purchases/${r.id}/undo-arrival`, 'POST')
        message.success('已撤销到货')
        await refresh()
      } catch (e) {
        message.error(apiError(e))
      }
    },
  })
}

function remove(r: PurchaseRow) {
  Modal.confirm({
    title: `删除 ${r.materialName}？`,
    content: '只用于录错了的；不再跟踪请在编辑里勾"已取消"',
    okText: '删除',
    okType: 'danger',
    async onOk() {
      try {
        await purchaseSend(`/api/purchases/${r.id}`, 'DELETE')
        message.success('已删除')
        await refresh()
      } catch (e) {
        message.error(apiError(e))
      }
    },
  })
}

// ───── 申请付款（勾选同一工单的几行）─────
const selectedKeys = ref<string[]>([])
const selectedRows = computed(() => rows.value.filter((r) => selectedKeys.value.includes(r.id)))
const paying = ref(false)
function openPay() {
  const wos = new Set(selectedRows.value.map((r) => r.workOrderNumber))
  if (wos.size > 1) return message.warning('一张付款申请只能关联同一个工单的物料')
  paying.value = true
}
async function paid() {
  paying.value = false
  selectedKeys.value = []
  await refresh()
}
const rowSelection = computed(() => ({
  selectedRowKeys: selectedKeys.value,
  onChange: (keys: (string | number)[]) => (selectedKeys.value = keys.map(String)),
  getCheckboxProps: (r: PurchaseRow) => ({ disabled: r.status === 'CANCELLED' }),
}))

const columns = [
  { title: '工单', dataIndex: 'workOrderNumber', width: 130 },
  { title: '物料', key: 'material', width: 210 },
  { title: '数量', key: 'qty', width: 80 },
  { title: '供应商', key: 'supplier', width: 150 },
  { title: '需求日', key: 'needDate', width: 100 },
  { title: '承诺到货', key: 'promisedDate', width: 100 },
  { title: '到货', key: 'arrived', width: 130 },
  { title: '进度', key: 'progress', width: 150 },
  { title: '延误原因', key: 'delay', width: 120 },
  { title: '负责人', key: 'owner', width: 120 },
  { title: '', key: 'actions', width: 150, fixed: 'right' as const },
]
const sourceText = { MOBILE: '手机', PC: '电脑', QMS_INSPECTION: 'QMS 进货检验' } as const
</script>

<template>
  <a-card title="采购到货（关键物料）">
    <template #extra>
      <a-space wrap>
        <a-radio-group v-model:value="filter.view" button-style="solid" size="small">
          <a-radio-button v-for="v in VIEWS" :key="v.value" :value="v.value">{{ v.label }}</a-radio-button>
        </a-radio-group>
        <a-select
          v-model:value="filter.workOrderNumber"
          allow-clear
          show-search
          placeholder="全部工单"
          style="width: 170px"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: w.workOrderNumber }))"
        />
        <a-input-search v-model:value="keyword" allow-clear placeholder="物料 / 规格 / 供应商" style="width: 180px" />
        <a-button @click="refresh()">刷新</a-button>
        <a-button @click="importing = true">Excel 导入</a-button>
        <a-button :disabled="!selectedKeys.length" @click="openPay">申请付款{{ selectedKeys.length ? `（${selectedKeys.length}）` : '' }}</a-button>
        <a-button type="primary" @click="openEdit(null)">登记关键物料</a-button>
      </a-space>
    </template>

    <div v-if="stats" class="stats">
      <a-space size="large" wrap>
        <span>未到货 <b>{{ stats.open }}</b></span>
        <a class="stat" :class="{ warn: stats.shortage }" @click="filter.view = 'shortage'">缺料 <b>{{ stats.shortage }}</b></a>
        <span :class="{ warn: stats.noPromise }">无承诺日 <b>{{ stats.noPromise }}</b></span>
        <span :class="{ warn: stats.blockedByPayment }">卡付款 <b>{{ stats.blockedByPayment }}</b></span>
        <a class="stat" @click="filter.view = 'late'">延误 <b>{{ stats.delay.late }}</b></a>
        <span v-if="stats.delay.late" class="muted">
          付款原因 <b>{{ stats.delay.payment }}</b> · 管理原因 <b>{{ stats.delay.management }}</b>（供应商 {{ stats.delay.byReason.SUPPLIER }}、我方需求变化 {{ stats.delay.byReason.DEMAND_CHANGE }}、其他 {{ stats.delay.byReason.OTHER }}）<template v-if="stats.delay.unfilled"> · <span class="warn">未填原因 {{ stats.delay.unfilled }}</span></template>
        </span>
      </a-space>
    </div>
    <p class="muted">只跟踪关键物料（长周期、进口、大件）。QMS 进货检验按"工单 + 物料名称（+ 供应商）"自动确认到货；也可以在这里或手机上手工确认。没指定采购负责人的派给采购部负责人。</p>

    <a-table
      :columns="columns"
      :data-source="rows"
      :loading="pending"
      row-key="id"
      size="small"
      :row-selection="rowSelection"
      :scroll="{ x: 1400 }"
      :pagination="{ pageSize: 50, hideOnSinglePage: true }"
    >
      <template #emptyText><a-empty :description="filter.view === 'open' ? '没有未到货的关键物料' : '没有记录'" /></template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'material'">
          <a @click="openEdit(record as PurchaseRow)">{{ record.materialName }}</a>
          <div class="muted">{{ [record.spec, record.partName ? `用于 ${record.partName}` : ''].filter(Boolean).join(' · ') }}</div>
        </template>
        <template v-else-if="column.key === 'qty'">{{ qtyText(record as PurchaseRow) }}</template>
        <template v-else-if="column.key === 'supplier'">
          {{ record.supplierName ?? '—' }}
          <div v-if="record.supplierName && !record.supplierId" class="muted">手填</div>
        </template>
        <template v-else-if="column.key === 'needDate'">{{ dayText(record.needDate) }}</template>
        <template v-else-if="column.key === 'promisedDate'">
          <span v-if="record.promisedDate">{{ dayText(record.promisedDate) }}</span>
          <span v-else class="muted">未承诺</span>
        </template>
        <template v-else-if="column.key === 'arrived'">
          <template v-if="record.arrivedDate">
            {{ dayText(record.arrivedDate) }}
            <div class="muted">{{ record.arrivalSource ? sourceText[record.arrivalSource as keyof typeof sourceText] : '' }}{{ record.arrivedByName && record.arrivalSource !== 'QMS_INSPECTION' ? ` · ${record.arrivedByName}` : '' }}</div>
          </template>
          <span v-else class="muted">—</span>
        </template>
        <template v-else-if="column.key === 'progress'">
          <a-tag :color="PURCHASE_PROGRESS_COLOR[record.progressText]">{{ record.progressText }}</a-tag>
          <a-tag v-if="record.alertLevel === 'RED'" color="red">红</a-tag>
          <a-tag v-else-if="record.alertLevel === 'YELLOW'" color="orange">黄</a-tag>
          <div v-if="record.lateDays" class="muted">晚 {{ record.lateDays }} 天</div>
          <a-tag v-if="record.blockedByPayment && record.status === 'OPEN'" color="purple">卡付款</a-tag>
        </template>
        <template v-else-if="column.key === 'delay'">
          <template v-if="record.delayReason">
            <a-tag :color="record.delayReason === 'PAYMENT' ? 'purple' : 'default'">{{ record.delayReasonText }}</a-tag>
            <div v-if="record.delayNote" class="muted ellipsis" :title="record.delayNote">{{ record.delayNote }}</div>
          </template>
          <a v-else-if="record.late" class="warn" @click="openEdit(record as PurchaseRow)">待填</a>
          <span v-else class="muted">—</span>
        </template>
        <template v-else-if="column.key === 'owner'"><span :class="{ muted: !record.buyerId }">{{ record.ownerText }}</span></template>
        <template v-else-if="column.key === 'actions'">
          <a-space size="small">
            <a-button v-if="record.status === 'OPEN'" type="primary" size="small" @click="openArrive(record as PurchaseRow)">确认到货</a-button>
            <a-button v-if="record.status === 'ARRIVED'" size="small" @click="undo(record as PurchaseRow)">撤销到货</a-button>
            <a-dropdown>
              <a-button size="small">更多</a-button>
              <template #overlay>
                <a-menu>
                  <a-menu-item key="edit" @click="openEdit(record as PurchaseRow)">编辑 / 填原因</a-menu-item>
                  <a-menu-item key="del" danger @click="remove(record as PurchaseRow)">删除</a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
          </a-space>
        </template>
      </template>
    </a-table>
  </a-card>

  <PurchaseEditModal :open="editOpen" :line="editing" :work-order-number="filter.workOrderNumber" @close="closeEdit" @done="saved" />
  <PurchaseImportModal :open="importing" @close="importing = false" @done="refresh()" />
  <PaymentCreateModal :open="paying" :lines="selectedRows" @close="paying = false" @done="paid" />

  <a-modal :open="!!arriving" :title="`确认到货：${arriving?.materialName ?? ''}`" ok-text="确认到货" :confirm-loading="busy" @ok="confirmArrive" @cancel="arriving = null">
    <a-form v-if="arriving" layout="vertical">
      <p class="muted">{{ arriving.workOrderNumber }} · {{ qtyText(arriving) }} · {{ arriving.supplierName ?? '未填供应商' }} · 需求日 {{ dayText(arriving.needDate) }}{{ arriving.promisedDate ? ` · 承诺 ${dayText(arriving.promisedDate)}` : '' }}</p>
      <a-form-item label="到货日期"><a-date-picker v-model:value="arrival.arrivedDate" value-format="YYYY-MM-DD" :allow-clear="false" /></a-form-item>
      <template v-if="arrivalLate">
        <a-form-item label="延误原因（晚于需求日或承诺日）">
          <a-radio-group v-model:value="arrival.delayReason" :options="DELAY_REASON_OPTIONS" />
          <div class="muted">不清楚可以先不填，采购稍后在编辑里补</div>
        </a-form-item>
        <a-form-item v-if="arrival.delayReason" label="说明"><a-input v-model:value="arrival.delayNote" :maxlength="500" /></a-form-item>
      </template>
    </a-form>
  </a-modal>
</template>

<style scoped>
.stats { margin-bottom: 8px; }
.stat { color: inherit; }
.muted { color: #999; font-size: 12px; }
.warn { color: #cf1322; }
.ellipsis { max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
