<script setup lang="ts">
/**
 * 采购到货（R10）：关键物料采购行列表、登记 / 编辑、Excel 导入、确认到货、申请付款。
 * 顶部统计：未到货、缺料、无承诺日、卡付款；延误按原因分"付款原因"和"管理原因"。
 * 地址栏 ?wo= 预选工单，?view= 选视图，?id= 打开某一行（预警提醒跳过来）。
 * 登记 / 编辑 / 删除 / 导入 / 确认到货 / 撤销 / 申请付款：采购部、该工单项目经理、管理员（权限方案 R13），其他人只读。
 * 前端改版第二轮：顶部统计卡（未到货 / 缺料 / 延误 / 卡付款，点了套用对应视图，数字是接口 stats，与视图同一口径）；
 * 列表默认按工单分组（?layout=group|table），组标题带本组到货完成度。
 */
import { distinctPlanNodes, groupByWorkOrder } from '#shared/workbench'
import { MAX_PAYMENT_LINES } from '#shared/purchases'

const route = useRoute()
const router = useRouter()
const { data: workOrders } = await useWorkOrders()
const { data: me } = await useMe()
const canEdit = (r: { workOrderNumber: string }) => canDo(me.value, 'purchase', { workOrderNumber: r.workOrderNumber })

const VIEWS = [
  { value: 'open', label: '未到货' },
  { value: 'shortage', label: '缺料' },
  { value: 'late', label: '延误' },
  { value: 'arrived', label: '已到货' },
  { value: 'cancelled', label: '已取消' },
  { value: 'all', label: '全部' },
] as const
/** 只由统计卡套用的视图（不在上面的单选里）：卡付款 */
const CARD_VIEWS = ['blocked']
function changeQuery(values: Record<string, string | undefined>, reset = true) {
  return router.replace({ query: { ...route.query, ...(reset ? { page: undefined } : {}), ...values } })
}
const filter = reactive({
  get workOrderNumber() { return typeof route.query.wo === 'string' ? route.query.wo : undefined },
  set workOrderNumber(value: string | undefined) { void changeQuery({ wo: value }) },
  get view() { return VIEWS.some((v) => v.value === route.query.view) || CARD_VIEWS.includes(route.query.view as string) ? route.query.view as string : route.query.id ? 'all' : 'open' },
  set view(value: string) { void changeQuery({ view: value }) },
  get q() { return typeof route.query.q === 'string' ? route.query.q : '' },
})
const keyword = ref(filter.q)
let timer: ReturnType<typeof setTimeout> | undefined
watch(keyword, (v) => {
  clearTimeout(timer)
  timer = setTimeout(() => { if (v.trim() !== filter.q) void changeQuery({ q: v.trim() || undefined }) }, 300)
})
watch(() => filter.q, (q) => { keyword.value = q })
onBeforeUnmount(() => clearTimeout(timer))
const page = computed({
  get: () => Math.max(1, Number(route.query.page) || 1),
  set: (value: number) => { void changeQuery({ page: value === 1 ? undefined : String(value) }, false) },
})
const pageSize = computed({
  get: () => [20, 50, 100].includes(Number(route.query.pageSize)) ? Number(route.query.pageSize) : 50,
  set: (value: number) => { void changeQuery({ pageSize: String(value) }) },
})
const list = usePagedList<PurchaseRow, PurchasePage>('/api/purchases', {
  key: 'purchase-desktop', page, pageSize,
  query: computed(() => ({ workOrderNumber: filter.workOrderNumber, view: filter.view, q: filter.q || undefined })),
})
await list.ready
const { rows, pending, error, total, refresh } = list
const stats = computed(() => list.data.value?.stats)
function changePage(p: number, size: number) {
  void changeQuery({ page: size === pageSize.value && p !== 1 ? String(p) : undefined, pageSize: String(size) }, false)
}

// ───── 统计卡、按工单分组 ─────
/** 点统计卡：套用对应视图；再点一次回到"未到货" */
const applyView = (view: string) => (filter.view = filter.view === view ? 'open' : view)
const layout = useListLayout()
/** 分组视图：每个工单一张小表（不再显示工单列）；表格视图：一张表 */
const tables = computed(() =>
  layout.value === 'group' ? groupByWorkOrder(rows.value).map((g) => ({ key: g.workOrderNumber, ...g })) : [{ key: '__all', workOrderNumber: '', rows: rows.value }],
)
const arrivedOf = (g: { workOrderNumber: string }) => list.data.value?.groups[g.workOrderNumber] ?? { done: 0, total: 0, count: 0 }

// ───── 新建 / 编辑 ─────
const editing = ref<PurchaseRow | null>(null)
const editOpen = ref(false)
let openSeq = 0
function openEdit(r: PurchaseRow | null) {
  openSeq++
  editing.value = r
  editOpen.value = true
}
async function saved() {
  openSeq++
  editOpen.value = false
  await refresh()
}
// ───── 留言（10-26）：所有能看到这一行的人都能看、能写、能 @人 ─────
const commenting = ref<{ id: string; name: string } | null>(null)

// ?id= 打开该行（从 W6 提醒跳过来）；再带 comments=1 打开留言（留言 @ 提醒跳过来）
async function openFromQuery() {
  const my = ++openSeq
  const id = route.query.id as string | undefined
  if (!id) return
  try {
    const line = await fetchPurchase(id)
    if (my !== openSeq) return // 连点两条提醒时，晚到的旧结果不再生效
    // 页面没离开时从别的工单的提醒跳过来：先切到该行所在工单，否则列表里找不到
    if (filter.workOrderNumber && filter.workOrderNumber !== line.workOrderNumber) filter.workOrderNumber = line.workOrderNumber
    if (route.query.comments === '1') {
      keyword.value = line.materialName
      commenting.value = { id: line.id, name: line.materialName }
      return
    }
    // 没有编辑权限（如收到 W6 的财务）：不弹编辑框，只把列表筛到这一条，只读查看
    if (!canEdit(line)) keyword.value = line.materialName
    else openEdit(line)
  } catch (e) {
    if (my === openSeq) message.error(apiError(e))
  }
}
onMounted(openFromQuery)
watch([() => route.query.id, () => route.query.comments], openFromQuery, { flush: 'sync' })
onBeforeUnmount(() => { openSeq++ })
function closeComments() {
  openSeq++
  commenting.value = null
  refresh()
  // 清掉定位参数，再点同一条留言提醒还能重新打开
  if (route.query.id || route.query.comments) router.replace({ query: { ...route.query, id: undefined, comments: undefined } })
}
function closeEdit() {
  openSeq++
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
const selection = ref(new Map<string, PurchaseRow>())
const selectedRows = computed(() => selectedKeys.value.map((id) => selection.value.get(id)).filter((r): r is PurchaseRow => !!r))
watch(rows, (value) => { for (const row of value) if (selectedKeys.value.includes(row.id)) selection.value.set(row.id, row) })
watch([() => filter.workOrderNumber, () => filter.view, () => filter.q], () => {
  if (selectedKeys.value.length) message.info('筛选已改变，已清空勾选的物料')
  selectedKeys.value = []
  selection.value.clear()
})
const paying = ref(false)
function openPay() {
  const wos = new Set(selectedRows.value.map((r) => r.workOrderNumber))
  if (wos.size > 1) return message.warning('一张付款申请只能关联同一个工单的物料')
  paying.value = true
}
async function paid() {
  paying.value = false
  selectedKeys.value = []
  selection.value.clear()
  await refresh()
}
/** 勾选：分组时每张小表各自勾选，合并成一份（换掉这张表里的勾选，别的表不动） */
function rowSelectionFor(list: PurchaseRow[]) {
  return {
    preserveSelectedRowKeys: true,
    selectedRowKeys: selectedKeys.value,
    onChange: (keys: (string | number)[]) => {
      if (keys.length > MAX_PAYMENT_LINES) return message.warning(`一张付款申请最多关联 ${MAX_PAYMENT_LINES} 项`)
      selectedKeys.value = keys.map(String)
      for (const row of list) if (selectedKeys.value.includes(row.id)) selection.value.set(row.id, row)
      for (const id of selection.value.keys()) if (!selectedKeys.value.includes(id)) selection.value.delete(id)
    },
    getCheckboxProps: (r: PurchaseRow) => ({ disabled: r.status === 'CANCELLED' || !canDo(me.value, 'payment', { workOrderNumber: r.workOrderNumber }) }),
  }
}

/**
 * 列宽按内容收紧（设计规范）：需求日和承诺到货合成一列上下两行；按工单分组时合计约 1090px（另有勾选列），1440 宽屏幕不用横向滚动。
 * 更窄的屏幕仍可横向滚动，操作列固定在右边。
 */
const columns = [
  { title: '工单', key: 'wo', width: 120 },
  { title: '总计划节点', key: 'planNode', width: 104 },
  { title: '物料', key: 'material', width: 154 },
  { title: '数量', key: 'qty', width: 64 },
  { title: '供应商', key: 'supplier', width: 120 },
  { title: '需求 / 承诺', key: 'dates', width: 108 },
  { title: '到货', key: 'arrived', width: 104 },
  { title: '进度', key: 'progress', width: 112 },
  { title: '延误原因', key: 'delay', width: 92 },
  { title: '负责人', key: 'owner', width: 80 },
  { title: '', key: 'actions', width: 150, fixed: 'right' as const },
]
const groupColumns = columns.filter((c) => c.key !== 'wo')
const tableWidth = columns.reduce((n, c) => n + c.width, 0)
const groupWidth = groupColumns.reduce((n, c) => n + c.width, 0)
const sourceText = { MOBILE: '手机', PC: '电脑', QMS_INSPECTION: 'QMS 进货检验' } as const
</script>

<template>
  <div>
  <div class="ft-page">
  <div v-if="stats" class="ft-stats">
    <UiStatCard label="未到货" :value="stats.open" unit="项" tone="primary" accent icon="dot" clickable :active="filter.view === 'open'" @click="applyView('open')">
      <template #sub>其中无承诺日 <span :class="{ warn: stats.noPromise }">{{ stats.noPromise }}</span></template>
    </UiStatCard>
    <UiStatCard label="缺料" :value="stats.shortage" unit="项" tone="late" accent icon="alert" clickable :active="filter.view === 'shortage'" sub="未到货且已到需求日" @click="applyView('shortage')" />
    <UiStatCard label="延误" :value="stats.delay.late" unit="项" tone="risk" accent icon="warn" clickable :active="filter.view === 'late'" @click="applyView('late')">
      <template #sub>付款原因 {{ stats.delay.payment }} · 管理原因 {{ stats.delay.management }}<template v-if="stats.delay.unfilled"> · <span class="warn">未填原因 {{ stats.delay.unfilled }}</span></template></template>
    </UiStatCard>
    <UiStatCard label="卡付款" :value="stats.blockedByPayment" unit="项" tone="upstream" accent icon="warn" clickable :active="filter.view === 'blocked'" sub="未到货，有没付的卡交期付款申请" @click="applyView('blocked')" />
  </div>
  <a-card>
    <template #title>
      <span class="ft-title">采购到货（关键物料）
        <UiHelpTip label="采购到货说明">只跟踪关键物料（长周期、进口、大件）。QMS 进货检验按"工单 + 物料名称（+ 供应商）"自动确认到货；也可以在这里或手机上手工确认。没指定采购负责人的派给采购部负责人。</UiHelpTip>
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
        <UiRefreshButton @click="refresh()" />
        <a-button v-if="canDoAny(me, 'purchase')" @click="importing = true">Excel 导入</a-button>
        <a-button v-if="canDoAny(me, 'payment')" :disabled="!selectedKeys.length" @click="openPay">申请付款{{ selectedKeys.length ? `（${selectedKeys.length}）` : '' }}</a-button>
        <a-button v-if="canDoAny(me, 'purchase')" type="primary" @click="openEdit(null)">登记关键物料</a-button>
      </a-space>
    </template>

    <!-- 左边按状态切换，右边是搜索和显示方式（设计规范：工具栏一行） -->
    <div class="ft-toolbar">
      <a-segmented v-model:value="filter.view" :options="VIEWS.map((v) => ({ value: v.value, label: v.label }))" />
      <div class="ft-toolbar-right">
        <a-input-search v-model:value="keyword" allow-clear placeholder="物料 / 规格 / 供应商" style="width: 180px" />
        <a-segmented v-model:value="layout" :options="LAYOUT_OPTIONS" />
      </div>
    </div>
    <p v-if="stats?.delay.late" class="muted">
      延误 {{ stats.delay.late }} 项：付款原因 <b>{{ stats.delay.payment }}</b> · 管理原因 <b>{{ stats.delay.management }}</b>（供应商 {{ stats.delay.byReason.SUPPLIER }}、我方需求变化 {{ stats.delay.byReason.DEMAND_CHANGE }}、其他 {{ stats.delay.byReason.OTHER }}）；已到货 {{ stats.arrived }} 项
    </p>
    <a-alert v-if="error" type="error" show-icon :message="`加载失败：${apiError(error)}`"><template #action><a-button @click="refresh()">重试</a-button></template></a-alert>
    <a-spin v-else-if="layout === 'group' && !rows.length" :spinning="pending"><a-empty :description="filter.view === 'open' ? '没有未到货的关键物料' : '没有记录'" /></a-spin>
    <div v-for="t in error ? [] : tables" :key="t.key" :class="{ 'ft-wo-group': layout === 'group' }">
    <UiWoGroupHead v-if="layout === 'group'" :no="t.workOrderNumber" :nodes="distinctPlanNodes(t.rows)" :done="arrivedOf(t).done" :total="arrivedOf(t).total" :matched-count="arrivedOf(t).count" label="到货" :count="t.rows.length" />
    <a-table
      :columns="layout === 'group' ? groupColumns : columns"
      :data-source="t.rows"
      :loading="pending"
      row-key="id"
      size="small"
      :row-selection="rowSelectionFor(t.rows)"
      :scroll="{ x: layout === 'group' ? groupWidth : tableWidth }"
      :pagination="false"
    >
      <template #emptyText><a-empty :description="filter.view === 'open' ? '没有未到货的关键物料' : '没有记录'" /></template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'material'">
          <a v-if="canEdit(record as PurchaseRow)" @click="openEdit(record as PurchaseRow)">{{ record.materialName }}</a>
          <span v-else>{{ record.materialName }}</span>
          <div class="muted">{{ [record.spec, record.partName ? `用于 ${record.partName}` : ''].filter(Boolean).join(' · ') }}</div>
          <button type="button" class="comment-link" @click="commenting = { id: record.id, name: record.materialName }">{{ record.commentCount ? `留言 ${record.commentCount}` : '留言' }}</button>
        </template>
        <template v-else-if="column.key === 'wo'"><WoLink :no="record.workOrderNumber" /></template>
        <template v-else-if="column.key === 'planNode'"><PlanNodeCell :work-order-number="record.workOrderNumber" :node="record.planNode" /></template>
        <template v-else-if="column.key === 'qty'">{{ qtyText(record as PurchaseRow) }}</template>
        <template v-else-if="column.key === 'supplier'">
          {{ record.supplierName ?? '—' }}
          <div v-if="record.supplierName && !record.supplierId" class="muted">手填</div>
        </template>
        <template v-else-if="column.key === 'dates'">
          {{ dayText(record.needDate) }}
          <div class="muted">{{ record.promisedDate ? `承诺 ${dayText(record.promisedDate)}` : '未承诺' }}</div>
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
          <a v-else-if="record.late && canEdit(record as PurchaseRow)" class="warn" @click="openEdit(record as PurchaseRow)">待填</a>
          <span v-else-if="record.late" class="warn">待填</span>
          <span v-else class="muted">—</span>
        </template>
        <template v-else-if="column.key === 'owner'"><span :class="{ muted: !record.buyerId }">{{ record.ownerText }}</span></template>
        <template v-else-if="column.key === 'actions'">
          <span v-if="!canEdit(record as PurchaseRow)" class="muted">—</span>
          <a-space v-else size="small">
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
    </div>
    <UiListPager v-if="!error" :page="page" :page-size="pageSize" :total="total" :loading="pending" @change="changePage" />
  </a-card>
  </div>

  <a-drawer :open="!!commenting" :title="`留言：${commenting?.name ?? ''}`" :width="520" destroy-on-close @close="closeComments">
    <CommentPanel v-if="commenting" ref-type="purchase" :ref-id="commenting.id" />
  </a-drawer>
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
  </div>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
.comment-link { padding: 0; border: 0; background: none; font-size: 12px; color: var(--ft-primary); cursor: pointer; }
.comment-link:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; border-radius: 2px; }
.warn { color: var(--ft-late); }
.ellipsis { max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
