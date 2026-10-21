<script setup lang="ts">
/**
 * 项目日历（zhao 10-21）：按周 / 按月看计划完成多少台、实际完成多少台，以及这一期到期的总计划节点（设计、采购、生产、发运…）。
 * 口径见 shared/calendar.ts：完成 = 总计划最后一个节点（发运）完成；台数 = QMS 工单数量；没有已发布总计划的按 QMS 交期计入计划。
 * 所有登录用户都能看全部工单（不分权限，不含金额）；点工单 / 节点进工单详情，详情页仍按原来的可见范围。
 * 地址栏 ?view=week|month&d=YYYY-MM-DD 记住当前视图和日期，便于分享。
 */
import { BUSINESS_DEPT_OPTIONS, type BusinessDeptCode } from '#shared/business-depts'
import { COMPLETION_STATE_TEXT, type CalendarView, type CompletionState, gridDays, periodOf, shiftPeriod } from '#shared/calendar'
import { NODE_STATE_TEXT, type NodeState } from '#shared/status'
import type { CalendarEntry } from '~/components/CalendarGrid.vue'

const route = useRoute()
const router = useRouter()
const view = computed<CalendarView>(() => (route.query.view === 'week' ? 'week' : 'month'))
const d = computed(() => (typeof route.query.d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(route.query.d) ? route.query.d : undefined))

const { data, pending, error, refresh } = await useFetch('/api/calendar', { key: 'calendar', query: { view, d } })

function go(query: { view?: CalendarView; d?: string }) {
  router.replace({ query: { ...route.query, view: query.view ?? view.value, d: query.d } })
}
const period = computed(() => data.value?.period ?? null)
function step(n: number) {
  if (period.value) go({ d: shiftPeriod(period.value, n).start })
}
const isCurrent = computed(() => !!data.value && data.value.today >= data.value.period.start && data.value.today <= data.value.period.end)
const viewOptions = [
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
]
const periodTitle = computed(() => {
  const p = period.value
  if (!p) return ''
  return p.view === 'month' ? `${p.start.slice(0, 4)}年${Number(p.start.slice(5, 7))}月` : `${p.start.slice(0, 4)}年 ${p.label}`
})
const unitWord = computed(() => (view.value === 'week' ? '本周' : '本月'))
const thisWord = computed(() => (isCurrent.value ? unitWord.value : view.value === 'week' ? '这一周' : '这个月'))

const dept = ref<BusinessDeptCode | undefined>(undefined)

// ───── 统计卡 ─────
const kpis = computed(() => {
  const s = data.value?.summary
  if (!s) return []
  return [
    { key: 'planned', label: '计划完成', value: s.planned.units, unit: `台 · ${s.planned.orders} 单`, tone: 'primary', sub: `计划完成日在${thisWord.value}` },
    { key: 'actual', label: '实际完成', value: s.actual.units, unit: `台 · ${s.actual.orders} 单`, tone: 'done', sub: '发运节点完成日在这一期' },
    { key: 'overdue', label: '逾期未完成', value: s.overdue.units, unit: `台 · ${s.overdue.orders} 单`, tone: s.overdue.orders ? 'late' : 'none', sub: s.overdue.orders ? '计划日已过、发运节点未完成' : '没有逾期' },
    { key: 'noPlan', label: '未排总计划', value: s.noPlan.units, unit: `台 · ${s.noPlan.orders} 单`, tone: 'none', sub: '按 QMS 交期计入计划，完成情况看不到' },
  ] as const
})

// ───── 趋势：前 2 期、本期、后 3 期 ─────
const trendBars = computed(() =>
  (data.value?.trend ?? []).map((t) => ({
    key: t.period.start,
    label: t.period.label,
    value: t.summary.planned.units,
    text: `计划 ${t.summary.planned.units} · 实际 ${t.summary.actual.units}`,
    tone: t.period.start === data.value?.period.start ? 'primary' : 'none',
  })),
)

// ───── 日历格子 ─────
const NODE_TONE: Record<NodeState, CalendarEntry['tone']> = { DONE: 'done', SOURCE: 'late', UPSTREAM: 'upstream', ON_TRACK: 'primary' }
const LEGEND_ICON = { DONE: 'check', ON_TRACK: 'dot', SOURCE: 'alert', UPSTREAM: 'warn' } as const
const detailLink = (no: string, node?: string | null) => `/wo/${encodeURIComponent(no)}${node ? `#node-${node}` : ''}`
function nodeStateText(n: { state: NodeState; actualDay: string | null; expectedDay: string; delayDays: number }) {
  if (n.state === 'DONE') return `已完成 ${n.actualDay?.slice(5) ?? ''}`.trim()
  if (n.delayDays > 0) return `${NODE_STATE_TEXT[n.state]}，预计 ${n.expectedDay.slice(5)}（晚 ${n.delayDays} 天）`
  return NODE_STATE_TEXT[n.state]
}
const days = computed(() => (period.value ? gridDays(period.value) : []))
const entries = computed<CalendarEntry[]>(() => {
  if (!data.value) return []
  const nodes = data.value.nodes
    .filter((n) => !dept.value || n.dept === dept.value)
    .map((n) => ({
      key: n.id,
      day: n.planDay,
      tone: NODE_TONE[n.state],
      stateText: nodeStateText(n),
      title: n.isLast ? `${n.workOrderNumber} ${n.name} ${n.quantity} 台` : `${n.workOrderNumber} ${n.name}`,
      sub: `${n.deptText}${n.projectName ? ` · ${n.projectName}` : ''}`,
      to: detailLink(n.workOrderNumber, n.id),
      strong: n.isLast,
    }))
  // 没有已发布总计划的工单：在 QMS 交期那天显示一条（按部门筛选时不显示，它不属于哪个部门）
  const noPlan = dept.value
    ? []
    : data.value.completions
        .filter((c) => c.source === 'DELIVERY' && c.planDay >= data.value!.period.start && c.planDay <= data.value!.period.end)
        .map((c) => ({
          key: `wo-${c.workOrderNumber}`,
          day: c.planDay,
          tone: 'none' as const,
          stateText: '未排总计划，按 QMS 交期',
          title: `${c.workOrderNumber} 交期 ${c.quantity} 台`,
          sub: c.projectName ?? c.customerName,
          to: detailLink(c.workOrderNumber),
          strong: true,
        }))
  return [...nodes, ...noPlan].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
})

// ───── 本期完成工单 ─────
const STATE_TONE: Record<CompletionState, 'done' | 'late' | 'primary' | 'none'> = { DONE: 'done', OVERDUE: 'late', PENDING: 'primary', NO_PLAN: 'none' }
type Completion = NonNullable<typeof data.value>['completions'][number]
function completionDesc(c: Completion) {
  if (c.source === 'DELIVERY') return `QMS 交期 ${c.planDay}（没有已发布的总计划）`
  const plan = `${c.nodeName ?? '发运'}计划 ${c.planDay}`
  if (c.done) return `${plan} · 实际 ${c.actualDay}`
  return c.expectedDay && c.expectedDay !== c.planDay ? `${plan} · 预计 ${c.expectedDay}` : plan
}
</script>

<template>
  <div class="ft-page cal-page">
    <header class="toolbar">
      <div class="left">
        <a-segmented :value="view" :options="viewOptions" @change="(v: string | number) => go({ view: v as CalendarView, d: period?.start })" />
        <div class="nav">
          <a-button size="small" aria-label="上一期" @click="step(-1)">‹</a-button>
          <span class="period">{{ periodTitle }}</span>
          <a-button size="small" aria-label="下一期" @click="step(1)">›</a-button>
        </div>
        <a-button v-if="!isCurrent" size="small" @click="go({ d: undefined })">回到{{ unitWord }}</a-button>
      </div>
      <div class="right">
        <a-select v-model:value="dept" allow-clear placeholder="全部部门" style="width: 130px" :options="BUSINESS_DEPT_OPTIONS" />
        <UiHelpTip label="项目日历说明">
          "完成"指总计划的发运节点（最后一个节点）完成，台数取 QMS 工单数量。计划完成日取已发布总计划里发运节点的当前计划日；没有已发布总计划的工单按 QMS 交期计入计划，系统里看不到它的完成情况。
          实际完成看发运节点的完成日（手动标记，或挂靠任务全部完成）。日历里的其他节点按计划日排，状态和总计划页一致。部门筛选只影响日历格子。所有人都能看全部工单。
        </UiHelpTip>
        <UiRefreshButton @click="refresh()" />
      </div>
    </header>

    <a-alert v-if="error" type="error" show-icon :message="apiError(error)" />
    <a-alert
      v-if="data?.summary.missingQuantity"
      type="warning"
      show-icon
      :message="`这一期有 ${data.summary.missingQuantity} 个工单在 QMS 里数量为 0，台数没算进去，请在 QMS 补上数量`"
    />

    <a-spin :spinning="pending">
      <div v-if="data" class="ft-page">
        <div class="kpis">
          <UiStatCard v-for="k in kpis" :key="k.key" :label="k.label" :value="k.value" :unit="k.unit" :tone="k.tone" :sub="k.sub" icon="dot" />
        </div>

        <UiSectionCard :title="view === 'week' ? '周日历' : '月日历'" sub="总计划节点按计划日排；加粗的是发运节点（附台数）">
          <CalendarGrid :view="view" :days="days" :start="data.period.start" :end="data.period.end" :today="data.today" :entries="entries" />
          <div class="legend" aria-hidden="true">
            <span v-for="s in (['DONE', 'ON_TRACK', 'SOURCE', 'UPSTREAM'] as const)" :key="s"><UiStatusIcon :kind="LEGEND_ICON[s]" :tone="NODE_TONE[s]" :size="12" />{{ NODE_STATE_TEXT[s] }}</span>
            <span><UiStatusIcon kind="ring" tone="none" :size="12" />未排总计划（QMS 交期）</span>
          </div>
        </UiSectionCard>

        <div class="cols">
          <UiSectionCard :title="`${thisWord}的完成工单（${data.completions.length}）`" sub="计划完成或实际完成在这一期">
            <div class="ft-well list">
              <UiListItem v-for="c in data.completions" :key="c.workOrderNumber" :tone="STATE_TONE[c.state]">
                <template #title><WoLink :no="c.workOrderNumber" /><span class="sub">{{ c.projectName ?? '' }}</span></template>
                <template #desc>{{ completionDesc(c) }}</template>
                <template #meta>{{ c.customerName }} · {{ c.quantity > 0 ? `${c.quantity} 台` : '数量未填' }}</template>
                <template #extra><UiStatusTag :tone="STATE_TONE[c.state]">{{ COMPLETION_STATE_TEXT[c.state] }}</UiStatusTag></template>
              </UiListItem>
              <a-empty v-if="!data.completions.length" description="这一期没有计划或实际完成的工单" />
            </div>
          </UiSectionCard>

          <UiSectionCard :title="view === 'week' ? '前后几周' : '前后几个月'" sub="条长 = 计划完成台数">
            <UiBarList :items="trendBars" :label-width="88" empty="没有数据" />
          </UiSectionCard>
        </div>
      </div>
    </a-spin>
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.left, .right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.nav { display: flex; align-items: center; gap: 6px; }
.period { min-width: 120px; text-align: center; font-size: 15px; font-weight: 600; color: var(--ft-text); font-variant-numeric: tabular-nums; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.cols { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 16px; align-items: start; }
.sub { font-size: 12px; font-weight: normal; color: var(--ft-text-2); }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 10px; font-size: 12px; color: var(--ft-text-2); }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
@media (max-width: 991px) { .cols { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 767px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
