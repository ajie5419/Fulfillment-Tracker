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
 * 只看要关注的（zhao 10-22）：只显示"预计拖期""有风险"的工单，"正常"和"未建总计划"的不显示（只给一行数量，点去"项目计划"看）；
 *   去掉"其余工单"卡和"按项目经理 / 表格视图"切换（zhao 10-22），只保留按状态分组。
 * 已完工 / 已取消的工单（zhao 10-22）：默认不显示；工具栏"显示已完工"打开后（?closed=1）在最下面单列一组，表格 / 按项目经理里也列出，
 *   但不进 4 个分组、汇总卡和"源头延误在哪个部门"。工单搜索默认也只搜在做的，打开开关后连已完工的一起搜。
 * 新建工单（履约新建工单 10-27）：工具栏蓝色主按钮，只有项目部、项目部负责人、管理员看得到（me.can.workOrder）；保存时写入 QMS 工单库。
 *   建好后跳到该工单详情，并问"是否现在套模板生成总计划"，点"生成"去项目计划页（/plan?wo=，现有的按模板生成入口）。
 */
import { BOARD_GROUP_TEXT, type BoardGroup, boardGroup } from '#shared/status'

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
const { data, pending, refresh } = await useFetch('/api/board', {
  query: closedQuery,
  default: () => ({ lastSyncAt: null, syncOldest: null, syncErrors: [], syncConfigured: false, summary: { red: 0, yellow: 0, green: 0 }, sourceByDept: [], rows: [] }),
})
/** 刷新：看板 + 领导那一块（BoardLeaderPanel 的数据 key 是 'overview'）一起刷新 */
async function refreshAll() {
  await Promise.all([refresh(), me.value?.can.overview ? refreshNuxtData('overview') : undefined])
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
const activeRows = computed(() => data.value.rows.filter((r) => !r.closed))
const closedRows = computed(() => data.value.rows.filter((r) => r.closed))
/** 要关注的：预计拖期 + 有风险（正常、未建总计划的不在本页显示） */
const focusRows = computed(() => activeRows.value.filter((r) => { const g = groupOf(r); return g === 'LATE' || g === 'RISK' }))
const grouped = computed(() => {
  const g: Record<BoardGroup, Row[]> = { LATE: [], RISK: [], OK: [], NO_PLAN: [] }
  for (const r of activeRows.value) g[groupOf(r)].push(r)
  // 拖期多的在前；其余保持看板顺序（红黄绿、交期近的在前）
  g.LATE.sort((a, b) => (b.delayDays ?? 0) - (a.delayDays ?? 0))
  return g
})
const COLUMNS: { key: 'LATE' | 'RISK'; icon: 'alert' | 'warn'; tone: 'late' | 'risk' }[] = [
  { key: 'LATE', icon: 'alert', tone: 'late' },
  { key: 'RISK', icon: 'warn', tone: 'risk' },
]
const deptItems = computed(() => data.value.sourceByDept.map((d) => ({ key: d.dept, label: d.deptText, value: d.nodes })))

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
        <a-button v-if="me?.can.workOrder" type="primary" @click="createOpen = true">新建工单</a-button>
      </div>
    </div>
    <a-alert v-if="data.syncErrors.length" type="error" show-icon class="sync-error" message="QMS 同步出错，数据可能不是最新" :description="syncErrorText" />

    <!-- 汇总 -->
    <div class="summary">
      <UiStatCard v-for="c in COLUMNS" :key="c.key" :label="BOARD_GROUP_TEXT[c.key]" :value="grouped[c.key].length" unit="个工单" :tone="c.tone" :icon="c.icon" accent />
      <UiSectionCard padding="tight" class="dept-card">
        <div class="dept-title">源头延误在哪个部门<span class="ft-muted">（节点数）</span></div>
        <UiBarList :items="deptItems" compact empty="没有源头延误的节点" />
      </UiSectionCard>
    </div>

    <!-- 原领导总览独有的内容（领导、项目部负责人、管理员） -->
    <BoardLeaderPanel v-if="me?.can.overview" />

    <a-spin :spinning="pending">
        <a-empty v-if="!focusRows.length" description="没有预计拖期或有风险的工单" class="empty" />
        <div v-else class="columns">
          <section v-for="c in COLUMNS" :key="c.key" class="col">
            <h2 class="col-title"><UiStatusIcon :kind="c.icon" :tone="c.tone" />{{ BOARD_GROUP_TEXT[c.key] }} · {{ grouped[c.key].length }}</h2>
            <div v-if="!grouped[c.key].length" class="col-empty ft-muted">没有</div>
            <BoardWoCard v-for="r in grouped[c.key]" :key="r.workOrderNumber" :row="r" :group="c.key" />
          </section>
        </div>
        <section v-if="closedRows.length" class="noplan-sec">
          <h2 class="col-title"><UiStatusIcon kind="check" tone="none" />已完工 / 已取消 · {{ closedRows.length }}</h2>
          <div class="noplan-grid">
            <BoardWoCard v-for="r in closedRows" :key="r.workOrderNumber" :row="r" :group="groupOf(r)" />
          </div>
        </section>
    </a-spin>
    <WorkOrderEditModal v-if="me?.can.workOrder" :open="createOpen" :work-order="null" @close="createOpen = false" @done="onCreated" />
  </div>
</template>

<style scoped>
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 8px 0 16px; }
.page-title { font-size: 22px; font-weight: 600; margin: 0; color: var(--ft-text); }
.tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
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
