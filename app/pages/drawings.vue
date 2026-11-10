<script setup lang="ts">
import type { ClientOptions } from '../utils/transport'
/**
 * 设计任务（R11）：按部件拆的设计任务列表（筛选：工单 / 设计负责人 / 视图含"逾期"）、新建 / 编辑、标记设计完成、录客户确认、
 * 一键发放（打开 R9 新建发放单并预填）；"设计负荷"页签按设计负责人列在手、逾期、本周到期。
 * 地址栏 ?wo= 预选工单，?view= 选视图，?owner= 选负责人，?tab=load 打开设计负荷，?id= 打开某个任务（W7 提醒跳过来）。
 * 新建 / 编辑 / 客户确认：技术部、管理员；一键发放：技术部、管理员；标记设计完成仍限设计负责人或管理员（权限方案 R13）。
 * Attention cards filter overdue / this-week work; lifecycle tabs carry scoped counts.
 * 列表默认按工单分组（?layout=group|table），组标题带本组设计完成度。
 */
import { isDesignComplete, MAX_CUSTOMER_CONFIRMATION_NOTE_LENGTH } from '#shared/drawing'
import { distinctPlanNodes, groupByWorkOrder, groupProgress } from '#shared/workbench'

const route = useRoute()
const router = useRouter()
const { data: workOrders, pending: ordersPending, error: ordersError, refresh: refreshOrders } = await useWorkOrders()
const { data: master, pending: masterPending, error: masterError, refresh: refreshMaster } = await useMaster()
const { data: me, error: meError, refresh: refreshMe } = await useMe()
const canEditTask = computed(() => canDo(me.value, 'drawing'))
const canRelease = computed(() => canDo(me.value, 'release'))

const VIEWS = [
  { value: 'open', label: '未完成' },
  { value: 'pending', label: '设计中' },
  { value: 'drawn', label: '待发放 / 待确认' },
  { value: 'done', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'all', label: '全部' },
] as const
/** Attention filters are separate from lifecycle tabs. */
const CARD_VIEWS = ['overdue', 'week']
const tab = ref(route.query.tab === 'load' ? 'load' : 'list')
type DrawingView = NonNullable<NonNullable<ClientOptions<'/api/drawings', 'GET'>['query']>['view']>
const filter = reactive({
  workOrderNumber: (route.query.wo as string) || undefined,
  ownerId: (route.query.owner as string) || undefined,
  view: VIEWS.some((v) => v.value === route.query.view) || CARD_VIEWS.includes(route.query.view as string) ? (route.query.view as DrawingView) : route.query.id ? 'all' : 'open',
  q: '',
})
const keyword = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
watch(keyword, (v) => {
  clearTimeout(timer)
  timer = setTimeout(() => (filter.q = v.trim()), 300)
})
watch(
  () => [filter.workOrderNumber, filter.view, filter.ownerId, tab.value],
  () => router.replace({ query: { ...route.query, wo: filter.workOrderNumber || undefined, view: filter.view, owner: filter.ownerId || undefined, tab: tab.value === 'load' ? 'load' : undefined } }),
)

watch(() => route.query, (q) => {
  filter.workOrderNumber = typeof q.wo === 'string' ? q.wo : undefined
  filter.ownerId = typeof q.owner === 'string' ? q.owner : undefined
  filter.view = typeof q.view === 'string' ? q.view as DrawingView : q.id ? 'all' : 'open'
  tab.value = q.tab === 'load' ? 'load' : 'list'
})

const layout = useListLayout('board', 'drawing-layout')
const hasFilters = computed(() => !!filter.workOrderNumber || (tab.value === 'list' && (!!filter.ownerId || !!keyword.value || filter.view !== 'open')))
const activeViewLabel = computed(() => CARD_VIEWS.includes(filter.view)
  ? filter.view === 'week' ? '本周到期' : '逾期'
  : VIEWS.find(v => v.value === filter.view)?.label)
function clearFilters() {
  filter.workOrderNumber = undefined
  if (tab.value !== 'list') return
  clearTimeout(timer)
  keyword.value = ''
  filter.q = ''
  filter.ownerId = undefined
  filter.view = 'open'
}
function changeLayout(value: unknown) {
  if (value !== 'group' && value !== 'board' && value !== 'table') return
  // The stage board has no cancelled column; do not carry that hidden filter into it.
  return router.replace({ query: { ...route.query, layout: value, view: value === 'board' && filter.view === 'cancelled' ? 'open' : filter.view } })
}
onBeforeUnmount(() => clearTimeout(timer))
const listQuery = computed(() => ({
  workOrderNumber: filter.workOrderNumber,
  ownerId: filter.ownerId,
  view: (layout.value === 'board' && filter.view === 'open' ? 'all' : filter.view) as DrawingView,
  q: filter.q || undefined,
}))
const requestFetch = useRequestFetch()
// 只由筛选 key 驱动请求，让不同筛选的结果与加载状态隔离。
const { data, pending, error, refresh } = await useAsyncData(
  computed(() => `drawings:${JSON.stringify(listQuery.value)}`),
  (_app, { signal }) => clientRequest('/api/drawings', { query: listQuery.value, signal }, requestFetch),
  { default: () => ({ rows: [] as DrawingRow[], total: 0, stats: null as DrawingStats | null }) },
)
const rows = computed(() => pending.value ? [] : data.value.rows as DrawingRow[])
const stats = computed(() => pending.value || error.value ? null : data.value.stats as DrawingStats | null)
const openCount = computed(() => (stats.value ? stats.value.pending + stats.value.drawn + stats.value.customerPending : null))
const drawnCount = computed(() => (stats.value ? stats.value.drawn + stats.value.customerPending : null))
const viewOptions = computed(() => {
  const s = stats.value
  const open = s ? s.pending + s.drawn + s.customerPending : 0
  const counts = s ? { open, pending: s.pending, drawn: s.drawn + s.customerPending, done: s.done, cancelled: s.cancelled, all: open + s.done + s.cancelled } : null
  return VIEWS.map((v) => ({ value: v.value, label: `${v.label} ${counts ? counts[v.value] : '—'}` }))
})

// ───── 统计卡、按工单分组 ─────
/** 点统计卡：套用对应视图并回到列表；再点一次回到"未完成" */
function applyView(view: DrawingView) {
  filter.view = filter.view === view ? 'open' : view
  tab.value = 'list'
}
function sortByNode(list: DrawingRow[]): DrawingRow[] {
  if (!list.some((r) => r.planNode)) return list
  return [...list].sort((a, b) => {
    const ca = a.planNode?.code ?? String(a.planNode?.seq ?? '')
    const cb = b.planNode?.code ?? String(b.planNode?.seq ?? '')
    if (!ca && !cb) return 0
    if (!ca) return 1
    if (!cb) return -1
    return ca.localeCompare(cb, undefined, { numeric: true })
  })
}
/** 分组视图：每个工单一张小表（不再显示工单列）；表格视图：一张表 */
const tables = computed(() =>
  layout.value === 'group'
    ? groupByWorkOrder(rows.value).map((g) => ({ key: g.workOrderNumber, ...g, rows: sortByNode(g.rows) }))
    : [{ key: '__all', workOrderNumber: '', rows: rows.value }],
)
const doneOf = (g: { rows: DrawingRow[] }) => groupProgress(g.rows, (r) => isDesignComplete(r.status), (r) => r.status !== 'CANCELLED')

const { data: load, pending: loadPending, error: loadError, refresh: refreshLoad } = await useFetch('/api/drawings/load', {
  query: computed(() => ({ workOrderNumber: filter.workOrderNumber })),
  default: () => ({ week: { monday: '', sunday: '' }, rows: [] as { ownerId: string | null; ownerName: string; open: number; pendingDraw: number; overdue: number; dueThisWeek: number; customerPending: number }[] }),
})
async function reload() {
  await Promise.all([refresh(), refreshLoad()])
}
function showOwner(ownerId: string | null, view: DrawingView = 'open') {
  if (!ownerId) return message.info('没指定设计负责人的任务请在列表里按"全部负责人"查看')
  Object.assign(filter, { ownerId, view })
  tab.value = 'list'
}

const ownerOptions = computed(() =>
  [...master.value.users]
    .sort((a, b) => Number(b.businessDept === 'TECH') - Number(a.businessDept === 'TECH'))
    .map((u) => ({ value: u.id, label: `${u.name}（${u.department || '无部门'}）` })),
)

// ───── 新建 / 编辑 ─────
const editing = ref<DrawingRow | null>(null)
const editOpen = ref(false)
let openSeq = 0
function openEdit(r: DrawingRow | null) {
  openSeq++
  editing.value = r
  editOpen.value = true
}
async function saved() {
  openSeq++
  editOpen.value = false
  await reload()
}
// ?id= 打开该任务（从 W7 提醒跳过来）
async function openFromQuery() {
  const my = ++openSeq
  const id = route.query.id as string | undefined
  if (!id) return
  try {
    const task = await fetchDrawing(id)
    if (my !== openSeq) return // 连点两条提醒时，晚到的旧结果不再生效
    // 页面没离开时从别的工单的提醒跳过来：先切到该任务所在工单，否则列表里找不到
    if (filter.workOrderNumber && filter.workOrderNumber !== task.workOrderNumber) filter.workOrderNumber = task.workOrderNumber
    // 没有编辑权限（如收到 W7 的项目经理）：不弹编辑框，只把列表筛到这一条，只读查看
    if (!canEditTask.value) keyword.value = task.componentName
    else openEdit(task)
  } catch (e) {
    if (my === openSeq) message.error(apiError(e))
  }
}
onMounted(openFromQuery)
watch(() => route.query.id, openFromQuery, { flush: 'sync' })
onBeforeUnmount(() => { openSeq++ })
function closeEdit() {
  openSeq++
  editOpen.value = false
  if (route.query.id) router.replace({ query: { ...route.query, id: undefined } })
}

// ───── 标记设计完成 / 客户确认（选日期，默认今天）─────
const acting = ref<{ row: DrawingRow; kind: 'drawn' | 'confirm' } | null>(null)
const actDate = ref(dayAfter(0))
const actNote = ref('')
const busy = ref(false)
function openAct(row: DrawingRow, kind: 'drawn' | 'confirm') {
  acting.value = { row, kind }
  actDate.value = dayAfter(0)
  actNote.value = ''
}
async function submitAct() {
  const a = acting.value
  if (!a) return
  busy.value = true
  try {
    const r = a.kind === 'drawn'
      ? await drawingSend(`/api/drawings/${a.row.id}/drawn`, 'POST', { date: actDate.value })
      : await drawingSend(`/api/drawings/${a.row.id}/confirm`, 'POST', { date: actDate.value, note: actNote.value.trim() || null })
    message.success(drawingResultText(r, a.kind === 'drawn' ? '已标记设计完成' : '已录客户确认'), 5)
    acting.value = null
    await reload()
  } catch (e) {
    message.error(apiError(e))
  } finally {
    busy.value = false
  }
}
function undo(row: DrawingRow, kind: 'drawn' | 'confirm') {
  Modal.confirm({
    title: kind === 'drawn' ? `撤销设计完成：${row.componentName}？` : `撤销客户确认：${row.componentName}？`,
    content: kind === 'drawn' ? '回到设计中（客户确认一并清掉），关联工件没处理的"可以开工"待办作废' : '回到未确认',
    okText: '撤销',
    async onOk() {
      try {
        const r = await drawingSend(`/api/drawings/${row.id}/${kind === 'drawn' ? 'undo-drawn' : 'undo-confirm'}`, 'POST')
        message.success(drawingResultText(r, '已撤销'))
        await reload()
      } catch (e) {
        message.error(apiError(e))
      }
    },
  })
}

function changeCancellation(row: DrawingRow) {
  const cancelled = row.status !== 'CANCELLED'
  Modal.confirm({
    title: `${cancelled ? '取消任务' : '恢复任务'}：${row.componentName}？`,
    content: cancelled
      ? '取消后不再预警、不计入节点完成统计，也不再阻挡关联工件的开工条件；已有发放记录保留。可通过“已取消”列表恢复。'
      : '恢复后重新计入节点完成统计，并按当前设计、发放和客户确认情况恢复状态及预警跟踪。',
    okText: cancelled ? '确认取消任务' : '恢复任务',
    okButtonProps: { danger: cancelled },
    async onOk() {
      try {
        const result = await drawingSend(`/api/drawings/${row.id}`, 'PATCH', { cancelled })
        message.success(drawingResultText(result, cancelled ? '已取消任务' : '已恢复任务'))
        await reload()
      } catch (error) {
        message.error(apiError(error))
        throw error
      }
    },
  })
}

// ───── 一键发放 ─────
const prefill = ref<ReleasePrefill | null>(null)
const releaseOpen = ref(false)
function openRelease(row: DrawingRow) {
  prefill.value = releasePrefillOf(row)
  releaseOpen.value = true
}
async function released() {
  releaseOpen.value = false
  await reload()
}

/** Keep desktop actions visible; narrow screens scroll the table without pinning actions. */
const columns = [
  { title: '工单', key: 'wo', width: 120 },
  { title: '任务名称', key: 'component', width: 180 },
  { title: '所属节点', key: 'planNode', width: 210 },
  { title: '责任人', key: 'owner', width: 110 },
  { title: '计划起止', key: 'planDate', width: 175 },
  { title: '设计状态', key: 'status', width: 165 },
  { title: '操作', key: 'actions', width: 170, align: 'right' as const, fixed: 'right' as const },
]
const sumWidth = (cols: { width: number }[]) => cols.reduce((n, c) => n + c.width, 0)
const groupColumns = columns.filter((c) => c.key !== 'wo')
const tableWidth = sumWidth(columns)
const groupWidth = sumWidth(groupColumns)
const partNames = (r: DrawingRow) => partsText(r.parts.map((p) => p.name))
const hasTaskDetails = (r: DrawingRow) => Boolean(r.drawnDate || r.customerConfirmedDate || r.releases.length || r.parts.length || r.note)
function planRangeText(r: DrawingRow): string {
  const end = dayText(r.planDate)
  if (!r.startDate) return end
  const start = dayText(r.startDate)
  if (start === end) return end
  return start.slice(0, 4) === end.slice(0, 4) ? `${start} ~ ${end.slice(5)}` : `${start} ~ ${end}`
}
const loadKey = (r: { ownerId: string | null }) => r.ownerId ?? '-'
const loadColumns = [
  { title: '设计负责人', key: 'owner' },
  { title: '在手（未完成）', dataIndex: 'open', width: 120, align: 'center' as const },
  { title: '设计中', dataIndex: 'pendingDraw', width: 90, align: 'center' as const },
  { title: '逾期', key: 'overdue', width: 90, align: 'center' as const },
  { title: '本周到期', key: 'week', width: 100, align: 'center' as const },
  { title: '待客户确认', dataIndex: 'customerPending', width: 110, align: 'center' as const },
]
</script>

<template>
  <div>
  <div class="ft-page">
  <a-alert v-if="ordersError" type="error" message="工单选项加载失败" :description="apiError(ordersError)"><template #action><a-button @click="refreshOrders()">重试</a-button></template></a-alert>
  <a-alert v-if="masterError" type="error" message="负责人选项加载失败" :description="apiError(masterError)"><template #action><a-button @click="refreshMaster()">重试</a-button></template></a-alert>
  <a-alert v-if="meError" type="error" message="用户权限加载失败" :description="apiError(meError)"><template #action><a-button @click="refreshMe()">重试</a-button></template></a-alert>
  <div class="ft-stats">
    <UiStatCard label="未完成" :value="openCount ?? '—'" unit="项" tone="primary" accent icon="dot" clickable :active="filter.view === 'open'" sub="设计中、待发放或待客户确认" @click="applyView('open')" />
    <UiStatCard label="待发放 / 待确认" :value="drawnCount ?? '—'" unit="项" tone="upstream" accent icon="ring" clickable :active="filter.view === 'drawn'" sub="已出图待发放到车间或待客户确认" @click="applyView('drawn')" />
    <UiStatCard label="本周到期" :value="stats ? stats.dueThisWeek : '—'" unit="项" tone="risk" accent icon="warn" clickable :active="filter.view === 'week'" sub="设计中且计划完成日在本周" @click="applyView('week')" />
    <UiStatCard label="逾期" :value="stats ? stats.overdue : '—'" unit="项" tone="late" accent icon="alert" clickable :active="filter.view === 'overdue'" sub="设计中过计划完成日，或客户确认过计划日" @click="applyView('overdue')" />
  </div>
  <UiSectionCard>
    <template #title>
      <div class="card-head-left">
        <span class="ft-title">设计任务</span>
        <a-segmented v-model:value="tab" :options="[{ value: 'list', label: '任务' }, { value: 'load', label: '人员负荷' }]" />
      </div>
    </template>
    <template #extra>
      <a-space>
        <UiRefreshButton @click="reload()" />
        <a-button v-if="canEditTask && tab === 'list'" @click="openEdit(null)">补充任务</a-button>
      </a-space>
    </template>

    <div class="task-filter-bar">
      <div class="task-filter-fields">
        <a-select
          v-model:value="filter.workOrderNumber"
          aria-label="筛选工单"
          :loading="ordersPending" :disabled="!!ordersError"
          allow-clear show-search option-filter-prop="label"
          placeholder="全部工单" class="order-filter"
          :options="workOrders.map(w => ({ value: w.workOrderNumber, label: w.workOrderNumber }))"
        />
        <template v-if="tab === 'list'">
          <a-select v-model:value="filter.ownerId" aria-label="筛选负责人" :loading="masterPending" :disabled="!!masterError" allow-clear show-search option-filter-prop="label" placeholder="全部负责人" class="owner-filter" :options="ownerOptions" />
          <a-input-search v-model:value="keyword" aria-label="搜索任务" allow-clear placeholder="搜索任务、工单或备注" class="task-search" />
        </template>
        <a-button v-if="hasFilters" type="link" size="small" @click="clearFilters">清除筛选</a-button>
      </div>
      <a-select v-if="tab === 'list'" :value="layout" aria-label="任务视图" class="layout-select" :options="DRAWING_LAYOUT_OPTIONS" @change="changeLayout" />
    </div>
    <div v-if="tab === 'list' && (layout !== 'board' || (filter.view !== 'open' && filter.view !== 'all'))" class="task-state-filters">
      <a-segmented v-if="layout !== 'board'" v-model:value="filter.view" :options="viewOptions" class="state-tabs" />
      <a-tag v-if="CARD_VIEWS.includes(filter.view) || (layout === 'board' && filter.view !== 'open' && filter.view !== 'all')" closable @close.prevent="filter.view = 'open'">{{ activeViewLabel }}</a-tag>
    </div>

    <!-- 页签栏隐藏，由上方统一单行工具栏切换 -->
    <a-tabs v-model:active-key="tab" class="no-nav">
      <a-tab-pane key="list" tab="设计任务">
        <a-result v-if="error && !pending" status="error" title="列表加载失败" :sub-title="apiError(error)"><template #extra><a-button @click="refresh()">重试</a-button></template></a-result>
        <template v-else>
        <p v-if="!pending && !error && data.total > rows.length" class="warn">共 {{ data.total }} 项，只显示前 {{ rows.length }} 项，请按工单或负责人筛选</p>

        <a-empty v-if="layout === 'board' && filter.view === 'cancelled'" description="已取消任务不进入阶段看板"><a-button @click="changeLayout('table')">在明细表查看已取消任务</a-button></a-empty>
        <DrawingKanbanBoard
          v-if="layout === 'board' && filter.view !== 'cancelled'"
          :rows="rows"
          :loading="pending"
          :can-edit-task="canEditTask"
          :can-release="canRelease"
          @edit="openEdit"
          @act="openAct"
          @release="openRelease"
          @undo="undo"
          @cancel="changeCancellation"
        />

        <template v-else-if="layout !== 'board'">
        <a-spin v-if="layout === 'group' && !rows.length" :spinning="pending"><a-empty v-if="!pending" :description="filter.view === 'open' ? '没有未完成的设计任务' : '没有记录'" /></a-spin>
        <div v-for="t in tables" :key="t.key" :class="{ 'ft-wo-group': layout === 'group' }">
        <UiWoGroupHead v-if="layout === 'group'" :no="t.workOrderNumber" :nodes="distinctPlanNodes(t.rows)" v-bind="doneOf(t)" label="设计完成" :count="t.rows.length" />
        <a-table
          class="ft-table"
          :columns="layout === 'group' ? groupColumns : columns"
          :data-source="t.rows"
          :loading="pending"
          row-key="id"
          size="small"
          :row-expandable="(r: DrawingRow) => hasTaskDetails(r)"
          :scroll="{ x: layout === 'group' ? groupWidth : tableWidth }"
          :pagination="layout === 'group' ? false : { pageSize: 50, hideOnSinglePage: true }"
        >
          <template #expandedRowRender="{ record }">
            <div class="task-details">
              <div><b>实际完成日</b><span>{{ record.drawnDate ? dayText(record.drawnDate) : '尚未完成' }}{{ record.drawnByName ? ` · ${record.drawnByName}` : '' }}</span></div>
              <div><b>客户确认</b><span v-if="!record.needsCustomerConfirm">不需要客户确认</span><template v-else><span v-if="record.customerConfirmedDate">已确认 {{ dayText(record.customerConfirmedDate) }} · {{ record.customerConfirmedByName }}</span><span v-else>计划 {{ record.customerPlanDate ? dayText(record.customerPlanDate) : '未定' }}</span></template></div>
              <div v-if="record.customerConfirmationNote"><b>确认说明</b><span>{{ record.customerConfirmationNote }}</span></div>
              <div v-if="record.releases.length"><b>发放记录</b><span><NuxtLink v-for="rel in record.releases" :key="rel.id" :to="`/releases?id=${encodeURIComponent(rel.id)}`" :class="{ void: rel.status === 'VOID' }">{{ rel.releaseNo }}{{ rel.status === 'VOID' ? '（已作废）' : '' }} </NuxtLink></span></div>
              <div v-if="record.parts.length"><b>关联工件</b><span>{{ partNames(record as DrawingRow) }}</span></div>
              <div v-if="record.note"><b>备注</b><span>{{ record.note }}</span></div>
            </div>
          </template>
          <template #emptyText><a-empty v-if="!pending" :description="filter.view === 'open' ? '没有未完成的设计任务' : '没有记录'" /></template>
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'component'">
              <button v-if="canEditTask" type="button" class="link-btn task-title-btn" @click="openEdit(record as DrawingRow)">{{ record.componentName }}</button>
              <span v-else class="task-title-text">{{ record.componentName }}</span>
              <span v-if="record.parts.length" class="muted"> · {{ record.parts.length }} 个工件</span>
            </template>
            <template v-else-if="column.key === 'wo'"><WoLink :no="record.workOrderNumber" /></template>
            <template v-else-if="column.key === 'planNode'"><PlanNodeCell :work-order-number="record.workOrderNumber" :node="record.planNode" /></template>
            <template v-else-if="column.key === 'owner'"><span :class="{ muted: !record.ownerId }">{{ record.ownerText }}</span></template>
            <template v-else-if="column.key === 'planDate'">
              <span class="plan-range" :class="{ warn: record.overdue && record.status === 'PENDING' }" :title="`开始：${record.startDate ? dayText(record.startDate) : '未填'} / 完成：${dayText(record.planDate)}`">
                {{ planRangeText(record as DrawingRow) }}
              </span>
            </template>
            <template v-else-if="column.key === 'status'">
              <div class="status-cell">
                <a-tag :color="DRAWING_STATUS_COLOR[record.status as DrawingStatusKey]">{{ record.presentation.designText }}</a-tag>
                <span v-if="record.presentation.designWarning" :class="record.presentation.designOverdue ? 'warn small' : 'risk small'">{{ record.presentation.designWarning }}</span>
                <span v-if="record.presentation.customerText" :class="record.presentation.customerOverdue ? 'warn small' : record.customerConfirmedDate ? 'confirmed small' : 'muted'">{{ record.presentation.customerText }}</span>
              </div>
            </template>
            <template v-else-if="column.key === 'actions'">
              <div class="row-actions">
                <a-button v-if="record.permissions.markDrawn" type="primary" size="small" @click="openAct(record as DrawingRow, 'drawn')">登记设计完成</a-button>
                <a-button v-if="record.status === 'DRAWN' && canRelease" type="primary" size="small" @click="openRelease(record as DrawingRow)">一键发放</a-button>
                <a-button v-if="record.permissions.confirm && canEditTask" size="small" @click="openAct(record as DrawingRow, 'confirm')">登记客户确认</a-button>
                <a-dropdown v-if="canEditTask || canRelease || record.permissions.undoDrawn">
                  <a-button size="small">更多</a-button>
                  <template #overlay>
                    <a-menu>
                      <a-menu-item v-if="canEditTask" key="edit" @click="openEdit(record as DrawingRow)">编辑任务</a-menu-item>
                      <a-menu-item v-if="canEditTask" key="cancel" :danger="record.status !== 'CANCELLED'" @click="changeCancellation(record as DrawingRow)">{{ record.status === 'CANCELLED' ? '恢复任务' : '取消任务' }}</a-menu-item>
                      <a-menu-item v-if="record.permissions.release && record.status !== 'DRAWN' && canRelease" key="rel" @click="openRelease(record as DrawingRow)">再发一版</a-menu-item>
                      <a-menu-item v-if="record.permissions.undoDrawn" key="undo" @click="undo(record as DrawingRow, 'drawn')">撤销设计完成</a-menu-item>
                      <a-menu-item v-if="record.customerConfirmedDate && canEditTask" key="undoc" @click="undo(record as DrawingRow, 'confirm')">撤销客户确认</a-menu-item>
                    </a-menu>
                  </template>
                </a-dropdown>
              </div>
            </template>
          </template>
        </a-table>
        </div>
        </template>
        </template>
      </a-tab-pane>

      <a-tab-pane key="load" tab="人员负荷">
        <a-spin v-if="loadPending" />
        <a-result v-else-if="loadError" status="error" title="人员负荷加载失败" :sub-title="apiError(loadError)"><template #extra><a-button @click="refreshLoad()">重试</a-button></template></a-result>
        <template v-else>
        <p class="muted">按设计负责人统计{{ filter.workOrderNumber ? `（工单 ${filter.workOrderNumber}）` : '' }}。逾期 = 设计中已过计划完成日，或客户确认已过计划日；本周到期 = 设计中且计划完成日在本周（{{ load.week.monday }} ~ {{ load.week.sunday }}）。点数字看明细。</p>
        <a-table class="ft-table" :columns="loadColumns" :data-source="load.rows" :loading="loadPending" :row-key="loadKey" size="middle" :pagination="false">
          <template #emptyText><a-empty description="没有未完成的设计任务" /></template>
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'owner'"><button type="button" class="link-btn" @click="showOwner(record.ownerId)">{{ record.ownerName }}</button></template>
            <template v-else-if="column.key === 'overdue'">
              <button v-if="record.overdue" type="button" class="link-btn warn" @click="showOwner(record.ownerId, 'overdue')">{{ record.overdue }}</button>
              <span v-else class="muted">0</span>
            </template>
            <template v-else-if="column.key === 'week'">
              <b v-if="record.dueThisWeek">{{ record.dueThisWeek }}</b>
              <span v-else class="muted">0</span>
            </template>
          </template>
        </a-table>
        </template>
      </a-tab-pane>
    </a-tabs>
  </UiSectionCard>
  </div>

  <DrawingEditModal :open="editOpen" :task="editing" :work-order-number="filter.workOrderNumber" @close="closeEdit" @done="saved" />
  <ReleaseCreateModal :open="releaseOpen" :prefill="prefill" @close="releaseOpen = false" @done="released" />

  <a-modal
    :open="!!acting"
    :title="acting ? `${acting.kind === 'drawn' ? '标记设计完成' : '登记客户确认'}：${acting.row.componentName}` : ''"
    ok-text="确定"
    :confirm-loading="busy"
    @ok="submitAct"
    @cancel="acting = null"
  >
    <a-form v-if="acting" layout="vertical">
      <p class="muted">{{ acting.row.workOrderNumber }} · 计划完成 {{ dayText(acting.row.planDate) }}{{ acting.row.needsCustomerConfirm ? ` · 客户确认计划 ${acting.row.customerPlanDate ? dayText(acting.row.customerPlanDate) : '未定'}` : '' }}</p>
      <a-form-item :label="acting.kind === 'drawn' ? '设计完成日期' : '实际客户确认日期'"><UiDatePicker v-model:value="actDate" :allow-clear="false" /></a-form-item>
      <a-form-item v-if="acting.kind === 'confirm'" label="确认说明（可选）"><a-textarea v-model:value="actNote" :maxlength="MAX_CUSTOMER_CONFIRMATION_NOTE_LENGTH" :rows="3" placeholder="填写客户回复、确认方式或凭据编号" /></a-form-item>
      <p v-if="acting.kind === 'confirm'" class="muted">登记设计成果确认；实际确认日期不能早于实际设计完成日期。</p>
      <p v-if="acting.kind === 'drawn'" class="muted">设计完成后点"一键发放"生成图纸发放单；发放后{{ acting.row.needsCustomerConfirm ? '、客户确认后' : '' }}任务完成。</p>
    </a-form>
  </a-modal>
  </div>
</template>

<style scoped>
.no-nav :deep(.ant-tabs-nav) { display: none; }
.task-filter-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.task-filter-fields { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.order-filter { width: 164px; }
.owner-filter { width: 148px; }
.task-search { width: 224px; }
.layout-select { width: 128px; }
.task-state-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.card-head-left { display: inline-flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.risk { color: var(--ft-risk-text); }
.confirmed { color: var(--ft-done-text); }
.muted { color: var(--ft-text-2); font-size: 12px; }
.link-btn { padding: 0; border: 0; background: none; font: inherit; color: var(--ft-primary); text-align: left; cursor: pointer; }
.link-btn:hover { text-decoration: underline; }
.link-btn:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; border-radius: 2px; }
.task-title-btn, .task-title-text { font-weight: 500; }
.warn { color: var(--ft-late-text); }
.small { font-size: 12px; }
.state-tabs { max-width: 100%; overflow-x: auto; }
.plan-range { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--ft-text-2); }
.status-cell { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.row-actions { display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px; white-space: nowrap; }
.task-details { display: grid; gap: 8px; padding: 8px 16px; }
.task-details > div { display: flex; flex-wrap: wrap; gap: 8px 16px; }
.task-details b { min-width: 84px; font-weight: 500; color: var(--ft-text-2); }
@media (max-width: 600px) {
  .task-filter-fields { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .order-filter, .owner-filter, .task-search { width: 100%; min-width: 0; }
  .task-search { grid-column: 1 / -1; }
  .task-filter-fields > .ant-btn { justify-self: start; }
  .state-tabs { min-width: 0; width: 100%; }
  .ft-table :deep(.ant-table-cell-fix-right) { position: static !important; }
  .ft-table :deep(.ant-table-cell-fix-right-first::after) { display: none; }
}
.void { text-decoration: line-through; color: var(--ft-text-3); }
</style>
