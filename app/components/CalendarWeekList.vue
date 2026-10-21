<script setup lang="ts">
/**
 * 项目日历 · 列表显示（zhao 10-21 第三轮选的方案 C）：本月的工单按周一到周日分组（截在当月范围内），每周一个分组行，
 * 写"第N周 10/19–10/25"和"X 单 · 共 Y 台"；本周的分组行用主色浅底。列：计划完成日 | 工单号 | 产品名称 | 台数 | 状态。
 * focus 给了日期时滚动到那一周（工作台"本周 / 下周"点进来用）。窄屏表格在框里横向滚动。颜色只用 --ft-* 变量。
 */
import { COMPLETION_STATE_TEXT, type CompletionState, addDay, periodOf } from '#shared/calendar'
import type { CalendarEntry } from '~/components/CalendarGrid.vue'

const props = defineProps<{ start: string; end: string; today: string; entries: CalendarEntry[]; focus?: string | null }>()

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
const weekdayOf = (d: string) => WEEKDAYS[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7]
const STATE_CLASS: Record<CompletionState, string> = { DONE: 's-done', OVERDUE: 's-late', PENDING: 's-pending', NO_PLAN: 's-noplan' }

const weeks = computed(() => {
  const out: { id: string; title: string; range: string; current: boolean; items: CalendarEntry[]; units: number }[] = []
  let n = 0
  for (let ws = periodOf('week', props.start).start; ws <= props.end; ws = addDay(ws, 7)) {
    n++
    const from = ws < props.start ? props.start : ws
    const we = addDay(ws, 6)
    const to = we > props.end ? props.end : we
    const items = props.entries.filter((e) => e.day >= from && e.day <= to).sort((a, b) => (a.day === b.day ? (a.no < b.no ? -1 : 1) : a.day < b.day ? -1 : 1))
    const current = props.today >= ws && props.today <= we
    out.push({
      id: `wk-${ws}`,
      title: `第${n}周${current ? '（本周）' : ''}`,
      range: from === to ? md(from) : `${md(from)}–${md(to)}`,
      current,
      items,
      units: items.reduce((s, e) => s + Math.max(0, e.qty), 0),
    })
  }
  return out
})

const root = ref<HTMLElement | null>(null)
function scrollToFocus() {
  const f = props.focus
  if (!f || f < props.start || f > props.end || !root.value) return
  const el = root.value.querySelector<HTMLElement>(`#wk-${periodOf('week', f).start}`)
  el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
onMounted(() => nextTick(scrollToFocus))
watch(() => [props.focus, props.start], () => nextTick(scrollToFocus))
</script>

<template>
  <UiSectionCard padding="none">
    <div ref="root" class="wrap">
      <div class="table" role="table" aria-label="本月计划完成的工单，按周分组">
        <div class="tr th" role="row">
          <span role="columnheader">计划完成日</span><span role="columnheader">工单号</span><span role="columnheader">产品名称</span>
          <span role="columnheader" class="r">台数</span><span role="columnheader" class="r">状态</span>
        </div>
        <template v-for="w in weeks" :key="w.id">
          <div :id="w.id" class="group" :class="{ current: w.current }" role="row">
            <span role="cell" class="g-title">{{ w.title }}<span class="g-range">{{ w.range }}</span></span>
            <span role="cell" class="g-sum">{{ w.items.length }} 单 · 共 <b>{{ w.units }}</b> 台</span>
          </div>
          <div v-for="e in w.items" :key="e.key" class="tr" role="row">
            <span role="cell" class="date">{{ md(e.day) }} {{ weekdayOf(e.day) }}</span>
            <span role="cell" class="ell"><NuxtLink :to="e.to">{{ e.no }}</NuxtLink></span>
            <span role="cell" class="ell">{{ e.product || '—' }}</span>
            <span role="cell" class="r qty">{{ e.qty > 0 ? e.qty : '?' }}<small>台</small></span>
            <span role="cell" class="r state" :class="STATE_CLASS[e.state]">{{ COMPLETION_STATE_TEXT[e.state] }}</span>
          </div>
          <div v-if="!w.items.length" class="tr empty" role="row"><span role="cell">这周没有计划完成的工单</span></div>
        </template>
      </div>
    </div>
  </UiSectionCard>
</template>

<style scoped>
.wrap { overflow-x: auto; }
.table { min-width: 640px; }
.tr { display: grid; grid-template-columns: 120px 180px minmax(0, 1fr) 100px 100px; align-items: center; gap: 12px; min-height: 44px; padding: 0 24px; border-top: 1px solid var(--ft-border); font-size: 14px; color: var(--ft-text); }
.th { min-height: 40px; border-top: 0; font-size: 13px; color: var(--ft-text-2); }
.r { text-align: right; }
.ell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.date { color: var(--ft-text-2); font-variant-numeric: tabular-nums; }
.qty { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
.qty small { margin-left: 2px; font-size: 12px; font-weight: 400; color: var(--ft-text-2); }
.state { font-size: 13px; }
.s-done { color: var(--ft-done-text); }
.s-late { color: var(--ft-late-text); }
.s-pending { color: var(--ft-text-2); }
.s-noplan { color: var(--ft-text-3); }
.empty { font-size: 13px; color: var(--ft-text-2); }
.empty span { grid-column: 1 / -1; }

.group { display: flex; align-items: baseline; gap: 12px; padding: 14px 24px 10px; background: var(--ft-fill); border-top: 1px solid var(--ft-border); scroll-margin-top: 16px; }
.group.current { background: var(--ft-primary-bg); }
.g-title { flex: 1; font-size: 15px; font-weight: 600; color: var(--ft-text); }
.g-range { margin-left: 12px; font-size: 13px; font-weight: 400; color: var(--ft-text-2); }
.g-sum { font-size: 13px; color: var(--ft-text-2); white-space: nowrap; }
.g-sum b { font-size: 18px; color: var(--ft-text); }
</style>
