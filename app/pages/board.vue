<script setup lang="ts">
/**
 * 项目总览（原"看板"，技术选型 6.2；前端改版第一轮改成卡片）：
 *   默认"按状态分组"：预计拖期 / 有风险 / 正常 三栏卡片，另列未建总计划的工单；顶部 4 张汇总卡 + 源头延误在哪个部门。
 *   每个工单一张卡：工单号 · 产品、项目经理 · 交期、拖期天数、总计划节点圆点、卡在哪个节点（最早的源头延误节点）、红预警 / 异常 / 缺件 / 齐套率。
 *   整张卡点进工单详情 /wo/:no。"按项目经理"按人分组；"表格视图"是原来的 14 列表格（工单号改链到详情）。
 * 顶部 QMS 最后同步时间（各类资源里最旧的那类），有资源同步报错时显示错误提示。
 * 红 = 有活动红色预警或超期 ≥3 天的异常；黄 = 有活动黄色预警或超期异常；否则绿。分组规则见 shared/status.ts boardGroup。
 * 功能重复梳理第一批（zhao 10-22）：
 *   原"领导总览"并入本页：领导、项目部负责人、管理员在汇总下方多看到一块（BoardLeaderPanel），旧地址 /overview 跳这里；
 *   全站只用"预计拖期 / 有风险 / 正常 / 未建总计划"一套分组，表格视图第一列也改成这套（不再显示红 / 黄 / 绿）；
 *   原菜单"工单详情"入口页去掉，改为工具栏里搜工单直接进详情。
 * 已完工 / 已取消的工单（zhao 10-22）：默认不显示；工具栏"显示已完工"打开后（?closed=1）在最下面单列一组，表格 / 按项目经理里也列出，
 *   但不进 4 个分组、汇总卡和"源头延误在哪个部门"。工单搜索默认也只搜在做的，打开开关后连已完工的一起搜。
 */
import { BOARD_GROUP_TEXT, type BoardGroup, boardGroup, woStatusText } from '#shared/status'

const route = useRoute()
const router = useRouter()
const { data: me } = await useMe()
/** 显示已完工 / 已取消的工单（地址栏 ?closed=1，刷新、分享链接都保留） */
// 直接由地址栏算出（不另存一份），浏览器前进 / 后退、站内跳转改了地址，开关和数据跟着变
const showClosed = computed({
  get: () => route.query.closed === '1',
  set: (v: boolean) => void router.replace({ query: { ...route.query, closed: v ? '1' : undefined } }),
})
const closedQuery = computed(() => (showClosed.value ? { closed: '1' } : {}))
const { data: workOrders } = await useFetch('/api/work-orders', { query: closedQuery, default: () => [] })
const woOptions = computed(() =>
  workOrders.value.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? w.customerName ?? ''}` })),
)
function openWo(no: unknown) {
  if (typeof no === 'string' && no) navigateTo(`/wo/${encodeURIComponent(no)}`)
}
const { data, pending, refresh } = await useFetch('/api/board', {
  query: closedQuery,
  default: () => ({ lastSyncAt: null, syncOldest: null, syncErrors: [], syncConfigured: false, summary: { red: 0, yellow: 0, green: 0 }, sourceByDept: [], rows: [] }),
})
/** 刷新：看板 + 领导那一块（BoardLeaderPanel 的数据 key 是 'overview'）一起刷新 */
async function refreshAll() {
  await Promise.all([refresh(), me.value?.can.overview ? refreshNuxtData('overview') : undefined])
}
type Row = (typeof data.value.rows)[number]

type View = 'status' | 'pm' | 'table'
const view = computed<View>({
  get: () => (route.query.view === 'table' || route.query.view === 'pm' ? route.query.view : 'status'),
  set: (v) => void router.replace({ query: { ...route.query, view: v === 'status' ? undefined : v } }),
})

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
const activeRows = computed(() => data.value.rows.filter((r) => !r.closed))
const closedRows = computed(() => data.value.rows.filter((r) => r.closed))
const grouped = computed(() => {
  const g: Record<BoardGroup, Row[]> = { LATE: [], RISK: [], OK: [], NO_PLAN: [] }
  for (const r of activeRows.value) g[groupOf(r)].push(r)
  // 拖期多的在前；其余保持看板顺序（红黄绿、交期近的在前）
  g.LATE.sort((a, b) => (b.delayDays ?? 0) - (a.delayDays ?? 0))
  return g
})
const COLUMNS: { key: Exclude<BoardGroup, 'NO_PLAN'>; icon: 'alert' | 'warn' | 'check'; tone: 'late' | 'risk' | 'done' }[] = [
  { key: 'LATE', icon: 'alert', tone: 'late' },
  { key: 'RISK', icon: 'warn', tone: 'risk' },
  { key: 'OK', icon: 'check', tone: 'done' },
]
const GROUP_TONE: Record<BoardGroup, 'late' | 'risk' | 'done' | 'none'> = { LATE: 'late', RISK: 'risk', OK: 'done', NO_PLAN: 'none' }
const GROUPS = (['LATE', 'RISK', 'OK', 'NO_PLAN'] as const).map((key) => ({ key, tone: GROUP_TONE[key] }))
const deptItems = computed(() => data.value.sourceByDept.map((d) => ({ key: d.dept, label: d.deptText, value: d.nodes })))

const byPm = computed(() => {
  const m = new Map<string, Row[]>()
  for (const r of [...activeRows.value, ...closedRows.value]) {
    const k = r.projectManagerName ?? '未设置项目经理'
    m.set(k, [...(m.get(k) ?? []), r])
  }
  return [...m.entries()].sort((a, b) => (a[0] === '未设置项目经理' ? 1 : b[0] === '未设置项目经理' ? -1 : a[0].localeCompare(b[0], 'zh-CN')))
})

// ───── 表格视图（原 14 列）─────
const columns = [
  { title: '状态', key: 'color', width: 110 },
  { title: '工单', key: 'wo', width: 260 },
  { title: '外协在途', dataIndex: 'outCount', width: 90, align: 'center' as const },
  { title: '超期', key: 'overdue', width: 120, align: 'center' as const },
  { title: '未关闭异常', key: 'issues', width: 100, align: 'center' as const },
  { title: '活动预警', key: 'alerts', width: 120 },
  { title: '未签收发放', key: 'releases', width: 100, align: 'center' as const },
  { title: '缺料', key: 'shortage', width: 70, align: 'center' as const },
  { title: '设计逾期', key: 'drawingOverdue', width: 90, align: 'center' as const },
  { title: '未齐套节点', key: 'incompleteNodes', width: 100, align: 'center' as const },
  { title: '项目经理', key: 'pm', width: 110 },
  { title: '交期', key: 'delivery', width: 110 },
  { title: '预计交期', key: 'expectedDelivery', width: 110 },
  { title: '拖期天数', key: 'delayDays', width: 90, align: 'center' as const },
]
const enc = encodeURIComponent
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">项目总览</h1>
      <div class="tools">
        <span class="ft-muted sync-time" :title="data.syncOldest ? `最旧的是：${data.syncOldest}` : undefined">QMS 最后同步：{{ syncText }}</span>
        <a-select
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
        <label class="closed-switch"><a-switch v-model:checked="showClosed" size="small" />显示已完工</label>
        <UiRefreshButton @click="refreshAll()" />
        <a-segmented v-model:value="view" :options="[{ value: 'status', label: '按状态分组' }, { value: 'pm', label: '按项目经理' }, { value: 'table', label: '表格视图' }]" />
      </div>
    </div>
    <a-alert v-if="data.syncErrors.length" type="error" show-icon class="sync-error" message="QMS 同步出错，数据可能不是最新" :description="syncErrorText" />

    <!-- 汇总 -->
    <div class="summary">
      <UiStatCard v-for="c in COLUMNS" :key="c.key" :label="BOARD_GROUP_TEXT[c.key]" :value="grouped[c.key].length" unit="个工单" :tone="c.tone" :icon="c.icon" accent />
      <UiStatCard :label="BOARD_GROUP_TEXT.NO_PLAN" :value="grouped.NO_PLAN.length" unit="个工单" tone="none" icon="ring" accent />
      <UiSectionCard padding="tight" class="dept-card">
        <div class="dept-title">源头延误在哪个部门<span class="ft-muted">（节点数）</span></div>
        <UiBarList :items="deptItems" compact empty="没有源头延误的节点" />
      </UiSectionCard>
    </div>

    <!-- 原领导总览独有的内容（领导、项目部负责人、管理员） -->
    <BoardLeaderPanel v-if="me?.can.overview" />

    <a-spin :spinning="pending">
      <!-- 按状态分组 -->
      <template v-if="view === 'status'">
        <a-empty v-if="!activeRows.length" description="没有在做的工单" class="empty" />
        <div v-else class="columns">
          <section v-for="c in COLUMNS" :key="c.key" class="col">
            <h2 class="col-title"><UiStatusIcon :kind="c.icon" :tone="c.tone" />{{ BOARD_GROUP_TEXT[c.key] }} · {{ grouped[c.key].length }}</h2>
            <div v-if="!grouped[c.key].length" class="col-empty ft-muted">没有</div>
            <BoardWoCard v-for="r in grouped[c.key]" :key="r.workOrderNumber" :row="r" :group="c.key" />
          </section>
        </div>
        <section v-if="grouped.NO_PLAN.length" class="noplan-sec">
          <h2 class="col-title"><UiStatusIcon kind="ring" />{{ BOARD_GROUP_TEXT.NO_PLAN }} · {{ grouped.NO_PLAN.length }}</h2>
          <div class="noplan-grid">
            <BoardWoCard v-for="r in grouped.NO_PLAN" :key="r.workOrderNumber" :row="r" group="NO_PLAN" />
          </div>
        </section>
        <section v-if="closedRows.length" class="noplan-sec">
          <h2 class="col-title"><UiStatusIcon kind="check" tone="none" />已完工 / 已取消 · {{ closedRows.length }}</h2>
          <div class="noplan-grid">
            <BoardWoCard v-for="r in closedRows" :key="r.workOrderNumber" :row="r" :group="groupOf(r)" />
          </div>
        </section>
      </template>

      <!-- 按项目经理 -->
      <template v-else-if="view === 'pm'">
        <a-empty v-if="!data.rows.length" description="没有可见的工单" class="empty" />
        <section v-for="[pm, rows] in byPm" :key="pm" class="pm-group">
          <h2 class="col-title">{{ pm }} · {{ rows.length }}</h2>
          <div class="noplan-grid">
            <BoardWoCard v-for="r in rows" :key="r.workOrderNumber" :row="r" :group="groupOf(r)" />
          </div>
        </section>
      </template>

      <!-- 表格视图（原看板） -->
      <UiSectionCard v-else padding="none">
        <div class="table-legend">
          <span v-for="g in GROUPS" :key="g.key"><UiStatusTag :tone="g.tone">{{ BOARD_GROUP_TEXT[g.key] }} {{ grouped[g.key].length }}</UiStatusTag></span>
          <span v-if="closedRows.length"><UiStatusTag tone="none">已完工 / 已取消 {{ closedRows.length }}</UiStatusTag></span>
          <span class="ft-muted">有风险 = 有源头延误节点、活动预警或超期异常</span>
        </div>
        <a-table :columns="columns" :data-source="[...activeRows, ...closedRows]" row-key="workOrderNumber" size="middle" :pagination="false" :scroll="{ x: 1500 }">
          <template #emptyText><a-empty description="没有可见的工单" /></template>
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'color'">
              <UiStatusTag v-if="record.closed" tone="none">{{ woStatusText(record.status) }}</UiStatusTag>
              <UiStatusTag v-else :tone="GROUP_TONE[groupOf(record as Row)]">{{ BOARD_GROUP_TEXT[groupOf(record as Row)] }}</UiStatusTag>
            </template>
            <template v-else-if="column.key === 'wo'">
              <WoLink :no="record.workOrderNumber" />
              <div class="ft-muted small">{{ record.projectName ?? record.customerName }}</div>
            </template>
            <template v-else-if="column.key === 'overdue'">
              <span :class="{ warn: record.overdueCount > 0 }">{{ record.overdueCount }}</span>
              <div v-if="record.overdueCount" class="ft-muted small">在途 {{ record.overdueSteps }} · 异常 {{ record.overdueIssues }}</div>
            </template>
            <template v-else-if="column.key === 'issues'">
              <NuxtLink v-if="record.openIssues" :to="`/issues?wo=${enc(record.workOrderNumber)}&dept=0`">{{ record.openIssues }}</NuxtLink>
              <span v-else>0</span>
            </template>
            <template v-else-if="column.key === 'alerts'">
              <NuxtLink v-if="record.redAlerts || record.yellowAlerts" :to="`/alerts?wo=${enc(record.workOrderNumber)}`">
                <a-tag v-if="record.redAlerts" color="error">红 {{ record.redAlerts }}</a-tag>
                <a-tag v-if="record.yellowAlerts" color="warning">黄 {{ record.yellowAlerts }}</a-tag>
              </NuxtLink>
              <span v-else class="ft-muted">—</span>
            </template>
            <template v-else-if="column.key === 'releases'">
              <NuxtLink v-if="record.unsignedReleases" :to="`/releases?wo=${enc(record.workOrderNumber)}&progress=PENDING`">{{ record.unsignedReleases }}</NuxtLink>
              <span v-else class="ft-muted">0</span>
            </template>
            <template v-else-if="column.key === 'shortage'">
              <NuxtLink v-if="record.shortage" class="warn" :to="`/purchases?wo=${enc(record.workOrderNumber)}&view=shortage`">{{ record.shortage }}</NuxtLink>
              <span v-else class="ft-muted">0</span>
            </template>
            <template v-else-if="column.key === 'drawingOverdue'">
              <NuxtLink v-if="record.drawingOverdue" class="warn" :to="`/drawings?wo=${enc(record.workOrderNumber)}&view=overdue`">{{ record.drawingOverdue }}</NuxtLink>
              <span v-else class="ft-muted">0</span>
            </template>
            <template v-else-if="column.key === 'incompleteNodes'">
              <NuxtLink v-if="record.incompleteNodes" class="warn" title="需求日前 N 天内（含已过）仍未齐套的装配节点" :to="`/kitting?wo=${enc(record.workOrderNumber)}&incomplete=1`">{{ record.incompleteNodes }}</NuxtLink>
              <span v-else class="ft-muted">0</span>
            </template>
            <template v-else-if="column.key === 'pm'">{{ record.projectManagerName ?? '—' }}</template>
            <template v-else-if="column.key === 'delivery'">{{ dayText(record.deliveryDate) }}</template>
            <template v-else-if="column.key === 'expectedDelivery'">
              <NuxtLink v-if="record.expectedDelivery" :to="{ path: '/plan', query: { wo: record.workOrderNumber } }" :class="{ warn: (record.delayDays ?? 0) > 0 }" title="按总计划推算（已发布的总计划）">{{ record.expectedDelivery }}</NuxtLink>
              <span v-else class="ft-muted" title="还没有发布总计划">—</span>
            </template>
            <template v-else-if="column.key === 'delayDays'">
              <a-tag v-if="(record.delayDays ?? 0) > 0" color="error" :title="`源头延误节点 ${record.delayedPlanNodes} 个`">{{ record.delayDays }} 天</a-tag>
              <span v-else-if="record.delayDays != null" class="ft-muted">0</span>
              <span v-else class="ft-muted">—</span>
            </template>
          </template>
        </a-table>
      </UiSectionCard>
    </a-spin>
  </div>
</template>

<style scoped>
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 8px 0 16px; }
.page-title { font-size: 22px; font-weight: 600; margin: 0; color: var(--ft-text); }
.tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sync-time { font-size: 12px; }
.sync-error { margin-bottom: 16px; }
.summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) minmax(0, 1.3fr); gap: 16px; margin-bottom: 20px; }
.dept-title { font-size: 13px; color: var(--ft-text-2); margin-bottom: 6px; }
.columns { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; align-items: start; }
.col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.col-title { display: flex; align-items: center; gap: 6px; margin: 0 0 2px; font-size: 15px; font-weight: 600; color: var(--ft-text); }
.col-empty { padding: 12px 4px; font-size: 13px; }
.noplan-sec, .pm-group { margin-top: 24px; }
.pm-group:first-child { margin-top: 0; }
/* align-items: start：卡片按各自内容高度，不被同一行最高的卡片拉高（否则只有两行字的卡片里空一大块） */
.noplan-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; margin-top: 10px; align-items: start; }
.empty { padding: 48px 0; }
.table-legend { display: flex; flex-wrap: wrap; gap: 8px 20px; padding: 14px 20px; }
.wo-search { width: 240px; }
.closed-switch { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ft-text-2); cursor: pointer; white-space: nowrap; }
.warn { color: var(--ft-late); font-weight: 600; }
.small { font-size: 12px; }
@media (max-width: 1279px) {
  .summary { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .dept-card { grid-column: 1 / -1; }
}
@media (max-width: 991px) {
  .columns { grid-template-columns: minmax(0, 1fr); }
  .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
