<script setup lang="ts">
/**
 * 项目总览（原"看板"，技术选型 6.2；前端改版第一轮改成卡片）：
 *   默认"按状态分组"：预计拖期 / 有风险 / 正常 三栏卡片，另列未建总计划的工单；顶部 4 张汇总卡 + 源头延误在哪个部门。
 *   每个工单一张卡：工单号 · 产品、项目经理 · 交期、拖期天数、总计划节点圆点、卡在哪个节点（最早的源头延误节点）、红预警 / 异常 / 缺件 / 齐套率。
 *   整张卡点进工单详情 /wo/:no。"按项目经理"按人分组；"表格视图"是原来的 14 列表格（工单号改链到详情）。
 * 顶部 QMS 最后同步时间（各类资源里最旧的那类），有资源同步报错时显示错误提示。
 * 红 = 有活动红色预警或超期 ≥3 天的异常；黄 = 有活动黄色预警或超期异常；否则绿。分组规则见 shared/status.ts boardGroup。
 */
import { BOARD_GROUP_TEXT, type BoardGroup, boardGroup } from '#shared/status'

const route = useRoute()
const router = useRouter()
const { data, pending, refresh } = await useFetch('/api/board', {
  default: () => ({ lastSyncAt: null, syncOldest: null, syncErrors: [], syncConfigured: false, summary: { red: 0, yellow: 0, green: 0 }, sourceByDept: [], rows: [] }),
})
type Row = (typeof data.value.rows)[number]

type View = 'status' | 'pm' | 'table'
const view = ref<View>(route.query.view === 'table' || route.query.view === 'pm' ? route.query.view : 'status')
watch(view, (v) => router.replace({ query: { ...route.query, view: v === 'status' ? undefined : v } }))

const syncText = computed(() => {
  if (data.value.lastSyncAt) return timeText(data.value.lastSyncAt)
  return data.value.syncConfigured ? '尚未完成首次同步' : '未同步（演示数据）'
})
const syncErrorText = computed(() =>
  data.value.syncErrors.map((e: { label: string; failCount: number; lastError: string }) => `${e.label}（连续失败 ${e.failCount} 次）：${e.lastError}`).join('；'),
)

// ───── 分组 ─────
const groupOf = (r: Row): BoardGroup => boardGroup(r)
const grouped = computed(() => {
  const g: Record<BoardGroup, Row[]> = { LATE: [], RISK: [], OK: [], NO_PLAN: [] }
  for (const r of data.value.rows) g[groupOf(r)].push(r)
  // 拖期多的在前；其余保持看板顺序（红黄绿、交期近的在前）
  g.LATE.sort((a, b) => (b.delayDays ?? 0) - (a.delayDays ?? 0))
  return g
})
const COLUMNS: { key: Exclude<BoardGroup, 'NO_PLAN'>; icon: 'alert' | 'warn' | 'check'; tone: 'late' | 'risk' | 'done' }[] = [
  { key: 'LATE', icon: 'alert', tone: 'late' },
  { key: 'RISK', icon: 'warn', tone: 'risk' },
  { key: 'OK', icon: 'check', tone: 'done' },
]
const deptItems = computed(() => data.value.sourceByDept.map((d) => ({ key: d.dept, label: d.deptText, value: d.nodes })))

const byPm = computed(() => {
  const m = new Map<string, Row[]>()
  for (const r of data.value.rows) {
    const k = r.projectManagerName ?? '未设置项目经理'
    m.set(k, [...(m.get(k) ?? []), r])
  }
  return [...m.entries()].sort((a, b) => (a[0] === '未设置项目经理' ? 1 : b[0] === '未设置项目经理' ? -1 : a[0].localeCompare(b[0], 'zh-CN')))
})

// ───── 表格视图（原 14 列）─────
const columns = [
  { title: '', key: 'color', width: 56 },
  { title: '工单', key: 'wo', width: 260 },
  { title: '外协在途', dataIndex: 'outCount', width: 90, align: 'center' as const },
  { title: '超期', key: 'overdue', width: 120, align: 'center' as const },
  { title: '未关闭异常', key: 'issues', width: 100, align: 'center' as const },
  { title: '活动预警', key: 'alerts', width: 120 },
  { title: '未签收发放', key: 'releases', width: 100, align: 'center' as const },
  { title: '缺料', key: 'shortage', width: 70, align: 'center' as const },
  { title: '出图逾期', key: 'drawingOverdue', width: 90, align: 'center' as const },
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
        <a-button size="small" :loading="pending" @click="refresh()">刷新</a-button>
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

    <a-spin :spinning="pending">
      <!-- 按状态分组 -->
      <template v-if="view === 'status'">
        <a-empty v-if="!data.rows.length" description="没有可见的工单" class="empty" />
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
          <span><span class="dot" :style="{ background: BOARD_COLOR.RED }" />红 {{ data.summary.red }}</span>
          <span><span class="dot" :style="{ background: BOARD_COLOR.YELLOW }" />黄 {{ data.summary.yellow }}</span>
          <span><span class="dot" :style="{ background: BOARD_COLOR.GREEN }" />绿 {{ data.summary.green }}</span>
          <span class="ft-muted">红 = 有红色预警或超期 ≥3 天的异常；黄 = 有黄色预警或超期异常</span>
        </div>
        <a-table :columns="columns" :data-source="data.rows" row-key="workOrderNumber" size="middle" :pagination="false" :scroll="{ x: 1500 }">
          <template #emptyText><a-empty description="没有可见的工单" /></template>
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'color'">
              <span class="light" :style="{ background: BOARD_COLOR[record.color as keyof typeof BOARD_COLOR] }" :title="BOARD_TEXT[record.color as keyof typeof BOARD_TEXT]">{{ BOARD_TEXT[record.color as keyof typeof BOARD_TEXT] }}</span>
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
              <NuxtLink v-if="record.expectedDelivery" :to="`/plan?wo=${enc(record.workOrderNumber)}`" :class="{ warn: (record.delayDays ?? 0) > 0 }" title="按总计划推算（已发布的总计划）">{{ record.expectedDelivery }}</NuxtLink>
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
.noplan-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; margin-top: 10px; }
.empty { padding: 48px 0; }
.table-legend { display: flex; flex-wrap: wrap; gap: 8px 20px; padding: 14px 20px; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
.light { display: inline-block; width: 28px; height: 28px; line-height: 28px; border-radius: 50%; color: var(--ft-card-bg); text-align: center; font-weight: 600; }
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
