<script setup lang="ts">
import type { ClientOptions } from '../utils/transport'
/**
 * 设计任务（R11）：按部件拆的设计任务列表（筛选：工单 / 设计负责人 / 视图含"逾期"）、新建 / 编辑、标记设计完成、录客户确认、
 * 一键发放（打开 R9 新建发放单并预填）；"设计负荷"页签按设计负责人列在手、逾期、本周到期。
 * 地址栏 ?wo= 预选工单，?view= 选视图，?owner= 选负责人，?tab=load 打开设计负荷，?id= 打开某个任务（W7 提醒跳过来）。
 * 新建 / 编辑 / 客户确认：技术部、管理员；一键发放：技术部、管理员；标记设计完成仍限设计负责人或管理员（权限方案 R13）。
 * 前端改版第二轮：顶部统计卡（设计中 / 逾期 / 本周到期 / 设计完成待发放·待确认，点了套用对应视图，数字是接口 stats，与视图同一口径）；
 * 列表默认按工单分组（?layout=group|table），组标题带本组设计完成度。
 */
import { isDesignComplete } from '#shared/drawing'
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
  { value: 'overdue', label: '逾期' },
  { value: 'drawn', label: '设计完成待发放 / 待确认' },
  { value: 'done', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'all', label: '全部' },
] as const
/** 只由统计卡套用的视图（不在上面的单选里）：设计中、本周到期 */
const CARD_VIEWS = ['pending', 'week']
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

const listQuery = computed(() => ({ workOrderNumber: filter.workOrderNumber, ownerId: filter.ownerId, view: filter.view, q: filter.q || undefined }))
const requestFetch = useRequestFetch()
// 只由筛选 key 驱动请求，让不同筛选的结果与加载状态隔离。
const { data, pending, error, refresh } = await useAsyncData(
  computed(() => `drawings:${JSON.stringify(listQuery.value)}`),
  (_app, { signal }) => clientRequest('/api/drawings', { query: listQuery.value, signal }, requestFetch),
  { default: () => ({ rows: [] as DrawingRow[], total: 0, stats: null as DrawingStats | null }) },
)
const rows = computed(() => pending.value ? [] : data.value.rows as DrawingRow[])
const stats = computed(() => pending.value || error.value ? null : data.value.stats as DrawingStats | null)

// ───── 统计卡、按工单分组 ─────
/** 点统计卡：套用对应视图并回到列表；再点一次回到"未完成" */
function applyView(view: DrawingView) {
  filter.view = filter.view === view ? 'open' : view
  tab.value = 'list'
}
const layout = useListLayout()
/** 分组视图：每个工单一张小表（不再显示工单列）；表格视图：一张表 */
const tables = computed(() =>
  layout.value === 'group' ? groupByWorkOrder(rows.value).map((g) => ({ key: g.workOrderNumber, ...g })) : [{ key: '__all', workOrderNumber: '', rows: rows.value }],
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
const busy = ref(false)
function openAct(row: DrawingRow, kind: 'drawn' | 'confirm') {
  acting.value = { row, kind }
  actDate.value = dayAfter(0)
}
async function submitAct() {
  const a = acting.value
  if (!a) return
  busy.value = true
  try {
    const r = await drawingSend(`/api/drawings/${a.row.id}/${a.kind === 'drawn' ? 'drawn' : 'confirm'}`, 'POST', { date: actDate.value })
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

/** 列宽按内容收紧（设计改版）：按工单分组时合计约 1120px，1440 宽的屏幕不用横向滚动；更窄的屏幕仍可横向滚动，操作列固定在右边 */
const columns = [
  { title: '工单', key: 'wo', width: 120 },
  { title: '总计划节点', key: 'planNode', width: 104 },
  { title: '部件 / 关联工件', key: 'component', width: 172 },
  { title: '设计负责人', key: 'owner', width: 96 },
  { title: '计划完成', key: 'planDate', width: 104 },
  { title: '设计完成', key: 'drawn', width: 94 },
  { title: '客户确认', key: 'customer', width: 128 },
  { title: '状态', key: 'status', width: 100 },
  { title: '发放单', key: 'releases', width: 98 },
  { title: '', key: 'actions', width: 222, fixed: 'right' as const },
]
const sumWidth = (cols: { width: number }[]) => cols.reduce((n, c) => n + c.width, 0)
const groupColumns = columns.filter((c) => c.key !== 'wo')
const tableWidth = sumWidth(columns)
const groupWidth = sumWidth(groupColumns)
const partNames = (r: DrawingRow) => partsText(r.parts.map((p) => p.name))
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
    <UiStatCard label="设计中" :value="stats ? stats.pending : '—'" unit="项" tone="primary" accent icon="dot" clickable :active="filter.view === 'pending'" sub="还没完成设计的任务" @click="applyView('pending')" />
    <UiStatCard label="逾期" :value="stats ? stats.overdue : '—'" unit="项" tone="late" accent icon="alert" clickable :active="filter.view === 'overdue'" sub="设计中过计划完成日，或客户确认过计划日" @click="applyView('overdue')" />
    <UiStatCard label="本周到期" :value="stats ? stats.dueThisWeek : '—'" unit="项" tone="risk" accent icon="warn" clickable :active="filter.view === 'week'" sub="设计中且计划完成日在本周" @click="applyView('week')" />
    <UiStatCard label="设计完成待发放 / 待确认" :value="stats ? stats.drawn + stats.customerPending : '—'" unit="项" tone="done" accent icon="check" clickable :active="filter.view === 'drawn'" @click="applyView('drawn')">
      <template #sub>待发放 {{ stats ? stats.drawn : '—' }} · 待客户确认 {{ stats ? stats.customerPending : '—' }}</template>
    </UiStatCard>
  </div>
  <a-card>
    <div class="ft-toolbar">
      <div class="ft-toolbar-left">
        <a-segmented v-model:value="tab" :options="[{ value: 'list', label: '设计任务' }, { value: 'load', label: '设计负荷' }]" />
        <a-segmented v-if="tab === 'list'" v-model:value="filter.view" :options="VIEWS.map((v) => ({ value: v.value, label: v.label }))" />
      </div>
      <div class="ft-toolbar-right">
        <a-select
          v-model:value="filter.workOrderNumber"
          :loading="ordersPending" :disabled="!!ordersError"
          allow-clear
          show-search
          placeholder="全部工单"
          style="width: 150px"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: w.workOrderNumber }))"
        />
        <template v-if="tab === 'list'">
          <a-select :loading="masterPending" :disabled="!!masterError" v-model:value="filter.ownerId" allow-clear show-search option-filter-prop="label" placeholder="全部负责人" style="width: 136px" :options="ownerOptions" />
          <a-input-search v-model:value="keyword" allow-clear placeholder="部件 / 工单 / 备注" style="width: 160px" />
          <a-segmented v-model:value="layout" :options="LAYOUT_OPTIONS" />
        </template>
        <UiRefreshButton @click="reload()" />
        <a-button v-if="canEditTask" type="primary" class="ft-btn-ink" @click="openEdit(null)">新建设计任务</a-button>
      </div>
    </div>

    <!-- 页签栏隐藏，由上方统一单行工具栏切换 -->
    <a-tabs v-model:active-key="tab" class="no-nav">
      <a-tab-pane key="list" tab="设计任务">
        <a-result v-if="error && !pending" status="error" title="列表加载失败" :sub-title="apiError(error)"><template #extra><a-button @click="refresh()">重试</a-button></template></a-result>
        <template v-else>
        <p v-if="!pending && !error && data.total > rows.length" class="warn">共 {{ data.total }} 项，只显示前 {{ rows.length }} 项，请按工单或负责人筛选</p>

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
          :scroll="{ x: layout === 'group' ? groupWidth : tableWidth }"
          :pagination="layout === 'group' ? false : { pageSize: 50, hideOnSinglePage: true }"
        >
          <template #emptyText><a-empty v-if="!pending" :description="filter.view === 'open' ? '没有未完成的设计任务' : '没有记录'" /></template>
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'component'">
              <button v-if="canEditTask" type="button" class="link-btn" @click="openEdit(record as DrawingRow)">{{ record.componentName }}</button>
              <span v-else>{{ record.componentName }}</span>
              <UiStatusTag v-if="!record.parts.length" tone="none">文档 / 原理图（无关联零件）</UiStatusTag>
              <div class="muted">{{ record.parts.length ? partNames(record as DrawingRow) : '未关联工件' }}</div>
            </template>
            <template v-else-if="column.key === 'wo'"><WoLink :no="record.workOrderNumber" /></template>
            <template v-else-if="column.key === 'planNode'"><PlanNodeCell :work-order-number="record.workOrderNumber" :node="record.planNode" /></template>
            <template v-else-if="column.key === 'owner'"><span :class="{ muted: !record.ownerId }">{{ record.ownerText }}</span></template>
            <template v-else-if="column.key === 'planDate'">
              <span :class="{ warn: record.overdue && record.status === 'PENDING' }">{{ dayText(record.planDate) }}</span>
            </template>
            <template v-else-if="column.key === 'drawn'">
              <template v-if="record.drawnDate">{{ dayText(record.drawnDate) }}<div class="muted">{{ record.drawnByName }}</div></template>
              <span v-else class="muted">—</span>
            </template>
            <template v-else-if="column.key === 'customer'">
              <span v-if="!record.needsCustomerConfirm" class="muted">不需要</span>
              <template v-else-if="record.customerConfirmedDate">已确认 {{ dayText(record.customerConfirmedDate) }}<div class="muted">{{ record.customerConfirmedByName }}</div></template>
              <template v-else>
                <span :class="{ warn: record.overdue && record.status !== 'PENDING' }">计划 {{ record.customerPlanDate ? dayText(record.customerPlanDate) : '未定' }}</span>
              </template>
            </template>
            <template v-else-if="column.key === 'status'">
              <a-tag :color="DRAWING_STATUS_COLOR[record.status as DrawingStatusKey]">{{ record.statusText }}</a-tag>
              <a-tag v-if="record.alertLevel === 'RED'" color="red">红</a-tag>
              <a-tag v-else-if="record.alertLevel === 'YELLOW'" color="orange">黄</a-tag>
              <div v-if="record.overdue" class="warn small">逾期</div>
              <NuxtLink v-if="record.status !== 'CANCELLED'" class="proc" :to="`/process?wo=${encodeURIComponent(record.workOrderNumber)}&view=all`" :title="record.processText">
                <div>料单{{ MATERIAL_STATUS_TEXT[record.materialStatus as MaterialStatusKey] }}</div>
                <div>工艺{{ PROCESS_STATUS_TEXT[record.processStatus as ProcessStatusKey] }}</div>
              </NuxtLink>
            </template>
            <template v-else-if="column.key === 'releases'">
              <div v-for="rel in record.releases" :key="rel.id">
                <NuxtLink :to="`/releases?id=${encodeURIComponent(rel.id)}`" :class="{ void: rel.status === 'VOID' }">{{ rel.releaseNo }}</NuxtLink>
                <span v-if="rel.status === 'VOID'" class="muted"> 已作废</span>
              </div>
              <span v-if="!record.releases.length" class="muted">—</span>
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-space size="small">
                <a-button v-if="record.permissions.markDrawn" type="primary" size="small" @click="openAct(record as DrawingRow, 'drawn')">标记设计完成</a-button>
                <a-button v-if="record.status === 'DRAWN' && canRelease" type="primary" size="small" @click="openRelease(record as DrawingRow)">一键发放</a-button>
                <a-button v-if="record.permissions.confirm && canEditTask" size="small" @click="openAct(record as DrawingRow, 'confirm')">客户确认</a-button>
                <a-dropdown v-if="canEditTask || canRelease || record.permissions.undoDrawn">
                  <a-button size="small">更多</a-button>
                  <template #overlay>
                    <a-menu>
                      <a-menu-item v-if="canEditTask" key="edit" @click="openEdit(record as DrawingRow)">编辑 / 取消</a-menu-item>
                      <a-menu-item v-if="record.permissions.release && record.status !== 'DRAWN' && canRelease" key="rel" @click="openRelease(record as DrawingRow)">再发一版</a-menu-item>
                      <a-menu-item v-if="record.permissions.undoDrawn" key="undo" @click="undo(record as DrawingRow, 'drawn')">撤销设计完成</a-menu-item>
                      <a-menu-item v-if="record.customerConfirmedDate && canEditTask" key="undoc" @click="undo(record as DrawingRow, 'confirm')">撤销客户确认</a-menu-item>
                    </a-menu>
                  </template>
                </a-dropdown>
              </a-space>
            </template>
          </template>
        </a-table>
        </div>
        </template>
      </a-tab-pane>

      <a-tab-pane key="load" tab="设计负荷">
        <a-spin v-if="loadPending" />
        <a-result v-else-if="loadError" status="error" title="设计负荷加载失败" :sub-title="apiError(loadError)"><template #extra><a-button @click="refreshLoad()">重试</a-button></template></a-result>
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
  </a-card>
  </div>

  <DrawingEditModal :open="editOpen" :task="editing" :work-order-number="filter.workOrderNumber" @close="closeEdit" @done="saved" />
  <ReleaseCreateModal :open="releaseOpen" :prefill="prefill" @close="releaseOpen = false" @done="released" />

  <a-modal
    :open="!!acting"
    :title="acting ? `${acting.kind === 'drawn' ? '标记设计完成' : '录客户确认'}：${acting.row.componentName}` : ''"
    ok-text="确定"
    :confirm-loading="busy"
    @ok="submitAct"
    @cancel="acting = null"
  >
    <a-form v-if="acting" layout="vertical">
      <p class="muted">{{ acting.row.workOrderNumber }} · 计划完成 {{ dayText(acting.row.planDate) }}{{ acting.row.needsCustomerConfirm ? ` · 客户确认计划 ${acting.row.customerPlanDate ? dayText(acting.row.customerPlanDate) : '未定'}` : '' }}</p>
      <a-form-item :label="acting.kind === 'drawn' ? '设计完成日期' : '客户确认日期'"><UiDatePicker v-model:value="actDate" :allow-clear="false" /></a-form-item>
      <p v-if="acting.kind === 'drawn'" class="muted">设计完成后点"一键发放"生成图纸发放单；发放后{{ acting.row.needsCustomerConfirm ? '、客户确认后' : '' }}任务完成。</p>
    </a-form>
  </a-modal>
  </div>
</template>

<style scoped>
.no-nav :deep(.ant-tabs-nav) { display: none; }
.muted { color: var(--ft-text-2); font-size: 12px; }
.link-btn { padding: 0; border: 0; background: none; font: inherit; color: var(--ft-primary); text-align: left; cursor: pointer; }
.link-btn:hover { text-decoration: underline; }
.link-btn:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; border-radius: 2px; }
.warn { color: var(--ft-late-text); }
.small { font-size: 12px; }
.proc { display: block; font-size: 12px; white-space: nowrap; }
.void { text-decoration: line-through; color: var(--ft-text-3); }
</style>
