<script setup lang="ts">
/**
 * 项目日历（zhao 10-21）：按月看每个工单的计划完成日和台数。
 * 第三轮（zhao 选方案 A + C）：只按月翻页，"日历 / 列表"两种显示可以切换。
 *   日历：月格里只放当天合计台数，点格子在右边看当天的工单（CalendarGrid）；列表：按周分组的表格（CalendarWeekList）。
 *   上面 6 张月度卡片：过去的月份看完成台数，当前和后面的看预计完成台数。
 * 口径见 shared/calendar.ts：完成 = 总计划最后一个节点（发运）完成；台数 = QMS 工单数量；没有已发布总计划的按 QMS 交期计入计划。
 * 所有登录用户都能看全部工单（不分权限，不含金额）；点工单进工单详情，详情页仍按原来的可见范围。
 * 地址栏 ?mode=calendar|list&d=YYYY-MM-DD；显示方式另外记在本机（localStorage），下次打开沿用。旧链接 ?view=week 转成列表。
 */
import { gridDays, shiftPeriod } from '#shared/calendar'
import type { CalendarEntry } from '~/components/CalendarGrid.vue'

type Mode = 'calendar' | 'list'
const MODE_KEY = 'ft-calendar-mode'

const route = useRoute()
const router = useRouter()
const qs = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : undefined)

// 旧链接 ?view=week|month（周视图已去掉）：周 → 列表，月 → 日历
if (qs('view')) {
  const { view: old, ...rest } = route.query
  await navigateTo({ query: { ...rest, mode: qs('mode') ?? (old === 'week' ? 'list' : 'calendar') } }, { replace: true })
}

const d = computed(() => {
  const v = qs('d')
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined
})
const mode = computed<Mode>(() => (qs('mode') === 'list' ? 'list' : 'calendar'))
const modeOptions = [
  { value: 'calendar', label: '日历' },
  { value: 'list', label: '列表' },
]
function setMode(m: Mode) {
  try {
    localStorage.setItem(MODE_KEY, m)
  } catch {
    // 隐私模式等存不了：只是下次不记得，不影响使用
  }
  router.replace({ query: { ...route.query, mode: m } })
}
onMounted(() => {
  if (qs('mode')) return
  let saved: string | null = null
  try {
    saved = localStorage.getItem(MODE_KEY)
  } catch {
    saved = null
  }
  if (saved === 'list') router.replace({ query: { ...route.query, mode: 'list' } })
})

const { data, pending, error, refresh } = await useFetch('/api/calendar', { key: 'calendar', query: { view: 'month', d } })

const period = computed(() => data.value?.period ?? null)
function go(day: string | undefined) {
  router.replace({ query: { ...route.query, d: day } })
}
function step(n: number) {
  if (period.value) go(shiftPeriod(period.value, n).start)
}
const isCurrent = computed(() => !!data.value && data.value.today >= data.value.period.start && data.value.today <= data.value.period.end)
const periodTitle = computed(() => (period.value ? `${period.value.start.slice(0, 4)}年${Number(period.value.start.slice(5, 7))}月` : ''))

// ───── 6 张月度卡片：过去的看完成，当前和后面的看预计完成 ─────
const monthCards = computed(() =>
  (data.value?.trend ?? []).map((t) => {
    const today = data.value?.today ?? ''
    const past = t.period.end < today
    const cur = t.period.start <= today && today <= t.period.end
    const s = t.summary
    return {
      key: t.period.start,
      label: cur ? `${t.period.label}（本月）` : t.period.label,
      value: past ? s.actual.units : cur ? s.actual.units + s.expected.units : s.expected.units,
      tone: past ? ('done' as const) : ('primary' as const),
      sub: past ? '已完成' : cur ? `已完成 ${s.actual.units} · 预计 ${s.expected.units}` : '预计完成',
      to: { path: '/calendar', query: { mode: mode.value, d: t.period.start } },
    }
  }),
)

// ───── 本月涉及的整周（含跨月的几天）的工单（排在计划完成日）；日历格里本月以外的日子不显示，列表里跨月的周列满 7 天 ─────
const days = computed(() => (period.value ? gridDays(period.value) : []))
const entries = computed<CalendarEntry[]>(() => {
  const g = days.value
  if (!g.length || !data.value) return []
  return data.value.completions
    .filter((c) => c.planDay >= g[0]! && c.planDay <= g.at(-1)!)
    .map((c) => ({
      key: c.workOrderNumber,
      day: c.planDay,
      no: c.workOrderNumber,
      product: c.projectName ?? '',
      qty: c.quantity,
      state: c.state,
      to: `/wo/${encodeURIComponent(c.workOrderNumber)}`,
    }))
})

// 日历里选中的日子：默认今天；今天不在这个月就选第一个有工单的日子（都没有选 1 号）
const picked = ref<string | null>(null)
const selected = computed(() => {
  const p = period.value
  if (!p || !data.value) return ''
  if (picked.value && picked.value >= p.start && picked.value <= p.end) return picked.value
  if (isCurrent.value) return data.value.today
  return entries.value.map((e) => e.day).filter((x) => x >= p.start && x <= p.end).sort()[0] ?? p.start
})
watch(() => period.value?.start, () => (picked.value = null))

// 列表滚动到哪一周：地址栏的日期（工作台"本周 / 下周"点进来），没有就今天
const focus = computed(() => d.value ?? data.value?.today ?? null)
</script>

<template>
  <div class="ft-page cal-page">
    <header class="toolbar">
      <div class="left">
        <a-button type="text" aria-label="上个月" class="nav" @click="step(-1)">‹</a-button>
        <h1 class="period">{{ periodTitle }}</h1>
        <a-button type="text" aria-label="下个月" class="nav" @click="step(1)">›</a-button>
        <a-button v-if="!isCurrent" size="small" @click="go(undefined)">回到本月</a-button>
      </div>
      <div class="right">
        <a-segmented :value="mode" :options="modeOptions" @change="(v: string | number) => setMode(v as Mode)" />
        <UiHelpTip label="项目日历说明">
          每个工单排在计划完成日（总计划发运节点的计划日；没有已发布总计划的按 QMS 交期），台数取 QMS 工单数量。台数标红 = 已过计划日还没完成。
          上面的卡片：过去的月份看实际完成台数，当前和后面的月份看预计完成台数（按总计划推算的日期，已经晚了的按今天算）。
        </UiHelpTip>
        <UiRefreshButton @click="refresh()" />
      </div>
    </header>

    <a-alert v-if="error" type="error" show-icon :message="apiError(error)" />
    <a-alert
      v-if="data?.summary.missingQuantity"
      type="warning"
      show-icon
      :message="`这个月有 ${data.summary.missingQuantity} 个工单在 QMS 里数量为 0，台数没算进去（显示为 ?），请在 QMS 补上数量`"
    />

    <a-spin :spinning="pending">
      <div v-if="data" class="ft-page">
        <div class="months">
          <UiStatCard v-for="m in monthCards" :key="m.key" :label="m.label" :value="m.value" unit="台" :tone="m.tone" :sub="m.sub" :to="m.to" :active="m.key === data.period.start" icon="dot" />
        </div>

        <CalendarGrid
          v-if="mode === 'calendar'"
          :days="days"
          :start="data.period.start"
          :end="data.period.end"
          :today="data.today"
          :entries="entries"
          :selected="selected"
          @update:selected="(day) => (picked = day)"
        />
        <CalendarWeekList v-else :start="data.period.start" :end="data.period.end" :today="data.today" :entries="entries" :focus="focus" />
      </div>
    </a-spin>
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.left, .right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.nav { font-size: 20px; color: var(--ft-text-2); }
.period { margin: 0; min-width: 140px; text-align: center; font-size: 28px; line-height: 36px; font-weight: 700; color: var(--ft-text); letter-spacing: 0.5px; font-variant-numeric: tabular-nums; }
.months { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 1199px) { .months { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 767px) {
  .months { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .period { font-size: 22px; min-width: 0; }
}
</style>
