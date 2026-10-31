<script setup lang="ts">
/**
 * 项目总览双视图：can.overview 默认看驾驶舱，其余角色只看工单看板。
 * 看板默认保留预计拖期 / 有风险两栏（允许重叠）、源头延误与已关闭工单；可切表格 / 项目经理。
 * 所有视图与筛选直接读 URL，提醒深链、前进 / 后退不依赖页面重建。
 */
import { BOARD_GROUP_TEXT, type BoardGroup, boardGroup, hasWorkOrderRisk, boardRiskSections, woStatusText } from '#shared/status'
import { BOARD_VIEWS, resolveBoardView, type BoardView } from '#shared/board-cockpit'

const route = useRoute()
const router = useRouter()
const { data: me } = await useMe()
const view = computed(() => resolveBoardView(!!me.value?.can.overview, route.query.view))
// 显式请求无权查看的 cockpit 时清正 URL；其余参数和锚点保留。
if (!me.value?.can.overview && route.query.view === 'cockpit') {
  await navigateTo({ path: '/board', query: { ...route.query, view: 'board' }, hash: route.hash }, { replace: true })
}
watch(() => route.query.view, (value) => {
  if (!me.value?.can.overview && value === 'cockpit') void router.replace({ query: { ...route.query, view: 'board' }, hash: route.hash })
})
function changeView(value: BoardView) { void router.replace({ query: { ...route.query, view: resolveBoardView(!!me.value?.can.overview, value) }, hash: route.hash }) }
const cockpit = ref<{ refresh: () => Promise<void> } | null>(null)
const layout = computed(() => route.query.layout === 'table' ? 'table' : route.query.layout === 'manager' ? 'manager' : 'status')
const boardLayouts = [{ value: 'status', label: '按状态' }, { value: 'manager', label: '按项目经理' }, { value: 'table', label: '表格视图' }]
function changeLayout(value: string) { void router.replace({ query: { ...route.query, layout: value } }) }
const redOnly = computed(() => route.query.color === 'RED')
function clearColor() { void router.replace({ query: { ...route.query, color: undefined } }) }
/** 显示已完工 / 已取消的工单（地址栏 ?closed=1，刷新、分享链接都保留） */
// 直接由地址栏算出（不另存一份），浏览器前进 / 后退、站内跳转改了地址，开关和数据跟着变
const showClosed = computed({
  get: () => route.query.closed === '1',
  set: (v: boolean) => void router.replace({ query: { ...route.query, closed: v ? '1' : undefined } }),
})
const closedQuery = computed(() => (showClosed.value ? { closed: '1' } : {}))
// 不含已完工时与全站工单下拉同一个缓存 key（'work-orders'），新建后一起刷新；含已完工时另用一个 key，不把已完工的混进别处的下拉
const { data: workOrders, refresh: refreshWorkOrders } = await useFetch('/api/work-orders', {
  key: computed(() => (showClosed.value ? 'work-orders:closed' : 'work-orders')),
  query: closedQuery,
  default: () => [],
})
const woOptions = computed(() =>
  workOrders.value.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? w.customerName ?? ''}` })),
)
function openWo(no: unknown) {
  if (typeof no === 'string' && no) navigateTo(`/wo/${encodeURIComponent(no)}`)
}
const { data, pending, error, refresh } = await useFetch('/api/board', {
  query: closedQuery,
  default: () => ({ lastSyncAt: null, syncOldest: null, syncErrors: [], syncConfigured: false, summary: { red: 0, yellow: 0, green: 0 }, sourceByDept: [], rows: [] }),
})
/** 驾驶舱只在有权限且被挂载时请求，普通角色不触发管理接口。 */
async function refreshAll() {
  await Promise.all([refresh(), cockpit.value?.refresh()])
}
type Row = (typeof data.value.rows)[number]

const syncText = computed(() => {
  if (data.value.lastSyncAt) return timeText(data.value.lastSyncAt)
  return data.value.syncConfigured ? '尚未完成首次同步' : '未同步（演示数据）'
})
const syncErrorText = computed(() =>
  data.value.syncErrors.map((e: { label: string; failCount: number; lastError: string }) => `${e.label}（连续失败 ${e.failCount} 次）：${e.lastError}`).join('；'),
)

// ───── 分组 ─────
const groupOf = (r: Row): BoardGroup => boardGroup(r)
/** 在做的工单（分组、汇总只算它们）；已完工 / 已取消的单列 */
const activeRows = computed(() => data.value.rows.filter((r) => !r.closed && (!redOnly.value || r.color === 'RED')))
const closedRows = computed(() => data.value.rows.filter((r) => r.closed && (!redOnly.value || r.color === 'RED')))
/** 要关注的：预计拖期 + 有风险（正常、未建总计划的不在本页显示） */
const focusRows = computed(() => activeRows.value.filter((r) => redOnly.value || hasWorkOrderRisk(r)))
const grouped = computed(() => {
  const g = boardRiskSections(activeRows.value)
  // 红色数字下钻也要列出红色但未建总计划的工单；默认两栏规则保持原样。
  if (redOnly.value) g.RISK = activeRows.value
  // 拖期多的在前；其余保持看板顺序（红黄绿、交期近的在前）
  g.LATE.sort((a, b) => (b.delayDays ?? 0) - (a.delayDays ?? 0))
  return g
})
const COLUMNS: { key: 'LATE' | 'RISK'; icon: 'alert' | 'warn'; tone: 'late' | 'risk' }[] = [
  { key: 'LATE', icon: 'alert', tone: 'late' },
  { key: 'RISK', icon: 'warn', tone: 'risk' },
]
const deptItems = computed(() => data.value.sourceByDept.map((d) => ({ key: d.dept, label: d.deptText, value: d.nodes })))

const managerGroups = computed(() => {
  const groups = new Map<string, { name: string; rows: Row[] }>()
  for (const row of focusRows.value) {
    const key = row.projectManagerId ?? ''
    const group = groups.get(key) ?? { name: row.projectManagerName ?? '未设置项目经理', rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  return [...groups.entries()].map(([key, group]) => ({ key, ...group }))
})
const tableRows = computed(() => [...focusRows.value, ...closedRows.value])
const tableColumns = [
  { title: '工单号', key: 'wo' }, { title: '项目', key: 'project' }, { title: '项目经理', dataIndex: 'projectManagerName' },
  { title: '交期', key: 'delivery' }, { title: '状态', key: 'status' }, { title: '预计交期', key: 'expected' },
  { title: '拖期天数', dataIndex: 'delayDays' }, { title: '外协在途', dataIndex: 'outCount' },
  { title: '外协超期', dataIndex: 'overdueSteps' }, { title: '未关闭异常', dataIndex: 'openIssues' },
  { title: '超期异常', dataIndex: 'overdueIssues' }, { title: '未签收发放', dataIndex: 'unsignedReleases' },
  { title: '缺料', dataIndex: 'shortage' }, { title: '齐套率', key: 'kit' },
]

// ───── 新建工单 ─────
const createOpen = ref(false)
async function onCreated(no: string) {
  createOpen.value = false
  // 工单下拉、看板一起刷新（回到总览时能看到新工单）；全站下拉的缓存也刷新
  await Promise.all([refreshWorkOrders(), refresh(), showClosed.value ? refreshNuxtData('work-orders') : undefined])
  await navigateTo(`/wo/${encodeURIComponent(no)}`)
  Modal.confirm({
    title: '是否现在套模板生成总计划？',
    content: `工单 ${no} 已建好。点“生成”去项目计划页，选模板后按模板生成。`,
    okText: '生成',
    cancelText: '稍后',
    onOk: () => navigateTo({ path: '/plan', query: { wo: no } }),
  })
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="head-left">
        <a-segmented v-if="me?.can.overview" :value="view" :options="BOARD_VIEWS" aria-label="项目总览视图" @change="changeView($event as BoardView)" />
        <span v-if="view === 'board'" class="ft-muted sync-time" :title="data.syncOldest ? `最旧的是：${data.syncOldest}` : undefined">QMS 最后同步：{{ syncText }}</span>
      </div>
      <div class="tools">
        <a-select
          v-if="view === 'board'"
          :value="undefined"
          show-search
          option-filter-prop="label"
          placeholder="搜工单号 / 项目，进详情"
          :options="woOptions"
          class="wo-search"
          aria-label="搜工单进详情"
          :not-found-content="'没有可见的工单'"
          @change="openWo"
        />
        <label v-if="view === 'board'" class="closed-switch"><a-switch v-model:checked="showClosed" size="small" />显示已完工</label>
        <UiRefreshButton @click="refreshAll()" />
        <a-button v-if="me?.can.workOrder" type="primary" @click="createOpen = true">新建工单</a-button>
      </div>
    </div>
    <a-alert v-if="data.syncErrors.length" type="error" show-icon class="sync-error" message="QMS 同步出错，数据可能不是最新" :description="syncErrorText" />

    <BoardCockpit v-if="view === 'cockpit' && me?.can.overview" ref="cockpit" />
    <template v-else>
    <a-result v-if="error" status="error" title="看板加载失败" :sub-title="apiError(error)"><template #extra><a-button @click="refresh()">重试</a-button></template></a-result>
    <template v-else>
    <!-- 汇总 -->
    <div class="summary">
      <UiStatCard v-for="c in COLUMNS" :key="c.key" :label="BOARD_GROUP_TEXT[c.key]" :value="grouped[c.key].length" :sub="c.key === 'RISK' ? '含预计拖期、预警、未关闭异常、缺件及未齐套，按工单去重' : undefined" unit="个工单" :tone="c.tone" :icon="c.icon" accent />
      <UiSectionCard padding="tight" class="dept-card">
        <div class="dept-title">源头延误在哪个部门<span class="ft-muted">（节点数）</span></div>
        <UiBarList :items="deptItems" compact empty="没有源头延误的节点" />
      </UiSectionCard>
    </div>

    <div class="ft-toolbar board-toolbar">
      <a-segmented :value="layout" :options="boardLayouts" aria-label="工单展示方式" @change="changeLayout($event as string)" />
      <a-tag v-if="redOnly" closable @close.prevent="clearColor">仅红色工单 · {{ activeRows.length }}</a-tag>
    </div>

    <a-spin :spinning="pending">
        <UiSectionCard v-if="layout === 'table'" padding="none">
          <a-table class="ft-table board-table" :columns="tableColumns" :data-source="tableRows" row-key="workOrderNumber" :pagination="false" size="small">
            <template #bodyCell="{ column, record: r }">
              <WoLink v-if="column.key === 'wo'" :no="r.workOrderNumber" />
              <template v-else-if="column.key === 'project'">{{ r.projectName ?? r.customerName }}</template>
              <template v-else-if="column.key === 'delivery'">{{ dayText(r.deliveryDate) }}</template>
              <template v-else-if="column.key === 'status'">{{ r.closed ? woStatusText(r.status) : BOARD_GROUP_TEXT[groupOf(r as Row)] }}</template>
              <template v-else-if="column.key === 'expected'">{{ r.expectedDelivery || '—' }}</template>
              <template v-else-if="column.key === 'kit'">{{ r.kitPercent == null ? '—' : `${r.kitPercent}%` }}</template>
            </template>
          </a-table>
        </UiSectionCard>
        <div v-else-if="layout === 'manager'" class="manager-groups">
          <UiSectionCard v-for="group in managerGroups" :key="group.key" :title="`${group.name} · ${group.rows.length}`" padding="tight">
            <div class="noplan-grid"><BoardWoCard v-for="r in group.rows" :key="r.workOrderNumber" :row="r" :group="groupOf(r)" /></div>
          </UiSectionCard>
          <a-empty v-if="!managerGroups.length" description="没有预计拖期或有风险的工单" />
        </div>
        <a-empty v-else-if="!focusRows.length" description="没有预计拖期或有风险的工单" class="empty" />
        <div v-else class="columns">
          <section v-for="c in COLUMNS" :key="c.key" class="col">
            <h2 class="col-title"><UiStatusIcon :kind="c.icon" :tone="c.tone" />{{ BOARD_GROUP_TEXT[c.key] }} · {{ grouped[c.key].length }}</h2>
            <div v-if="!grouped[c.key].length" class="col-empty ft-muted">没有</div>
            <BoardWoCard v-for="r in grouped[c.key]" :key="r.workOrderNumber" :row="r" :group="c.key" />
          </section>
        </div>
        <section v-if="closedRows.length && layout !== 'table'" class="noplan-sec">
          <h2 class="col-title"><UiStatusIcon kind="check" tone="none" />已完工 / 已取消 · {{ closedRows.length }}</h2>
          <div class="noplan-grid">
            <BoardWoCard v-for="r in closedRows" :key="r.workOrderNumber" :row="r" :group="groupOf(r)" />
          </div>
        </section>
    </a-spin>
    </template>
    </template>
    <WorkOrderEditModal v-if="me?.can.workOrder" :open="createOpen" :work-order="null" @close="createOpen = false" @done="onCreated" />
  </div>
</template>

<style scoped>
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 0 0 16px; }
.head-left { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-left: auto; }
.sync-time { font-size: 12px; }
.sync-error { margin-bottom: 16px; }
.summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)) minmax(0, 1.6fr); gap: 16px; margin-bottom: 20px; }
.dept-title { font-size: 13px; color: var(--ft-text-2); margin-bottom: 6px; }
.columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
.col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.col-title { display: flex; align-items: center; gap: 6px; margin: 0 0 2px; font-size: 15px; font-weight: 600; color: var(--ft-text); }
.col-empty { padding: 12px 4px; font-size: 13px; }
.noplan-sec { margin-top: 24px; }
/* align-items: start：卡片按各自内容高度，不被同一行最高的卡片拉高（否则只有两行字的卡片里空一大块） */
.noplan-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; margin-top: 10px; align-items: start; }
.manager-groups { display: grid; gap: 16px; }
.board-toolbar { margin-bottom: 16px; }
.board-table { overflow-x: auto; }
.board-table :deep(th), .board-table :deep(td) { font-size: 12px; padding: 8px 6px; overflow-wrap: anywhere; }
.empty { padding: 48px 0; }
.wo-search { width: 240px; }
.closed-switch { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ft-text-2); cursor: pointer; white-space: nowrap; }
@media (max-width: 1279px) {
  .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dept-card { grid-column: 1 / -1; }
}
@media (max-width: 991px) {
  .columns { grid-template-columns: minmax(0, 1fr); }
  .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
