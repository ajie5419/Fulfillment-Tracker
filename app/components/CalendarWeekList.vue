<script setup lang="ts">
/**
 * 项目日历 · 列表显示（zhao 10-21 第三轮选的方案 C）：本月涉及的每一周（周一到周日，跨月的周也列满 7 天）一个分组行，
 * 写"第N周 10/26–11/1"和"X 单 · 共 Y 台"；本周的分组行用主色浅底。列：计划完成日 | 工单号 | 产品名称 | 台数 | 状态。
 * 跨月的周列满 7 天，和工作台"本周 / 下周"卡片的统计范围一致（点进来看到的单数、台数对得上）。
 * focus 给了日期时滚动到那一周（工作台"本周 / 下周"点进来用）。
 * 按设计规范用 a-table + ft-table；分组行占满整行（colSpan）。状态同时给文字，不只靠颜色。
 */
import { COMPLETION_STATE_TEXT, type CompletionState, addDay, periodOf } from '#shared/calendar'
import type { CalendarEntry } from '~/components/CalendarGrid.vue'

const props = defineProps<{ start: string; end: string; today: string; entries: CalendarEntry[]; focus?: string | null }>()

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
const weekdayOf = (d: string) => WEEKDAYS[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7]
const STATE_TONE: Record<CompletionState, 'done' | 'late' | 'primary' | 'none'> = { DONE: 'done', OVERDUE: 'late', PENDING: 'primary', NO_PLAN: 'none' }

type Row =
  | { kind: 'group'; key: string; id: string; title: string; range: string; current: boolean; orders: number; units: number }
  | { kind: 'item'; key: string; e: CalendarEntry }
  | { kind: 'empty'; key: string }

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  let n = 0
  for (let ws = periodOf('week', props.start).start; ws <= props.end; ws = addDay(ws, 7)) {
    n++
    const we = addDay(ws, 6)
    const items = props.entries.filter((e) => e.day >= ws && e.day <= we).sort((a, b) => (a.day === b.day ? (a.no < b.no ? -1 : 1) : a.day < b.day ? -1 : 1))
    const current = props.today >= ws && props.today <= we
    out.push({
      kind: 'group',
      key: `g-${ws}`,
      id: `wk-${ws}`,
      title: `第${n}周${current ? '（本周）' : ''}`,
      range: `${md(ws)}–${md(we)}`,
      current,
      orders: items.length,
      units: items.reduce((s, e) => s + Math.max(0, e.qty), 0),
    })
    for (const e of items) out.push({ kind: 'item', key: e.key, e })
    if (!items.length) out.push({ kind: 'empty', key: `e-${ws}` })
  }
  return out
})

// 分组行、空行占满整行：第一列 colSpan = 全部列数，其余列 0
const full = (r: Row) => (r.kind === 'item' ? {} : { colSpan: 5 })
const hidden = (r: Row) => (r.kind === 'item' ? {} : { colSpan: 0 })
const columns = [
  { title: '计划完成日', key: 'day', width: 120, customCell: full },
  { title: '工单号', key: 'no', width: 180, ellipsis: true, customCell: hidden },
  { title: '产品名称', key: 'product', ellipsis: true, customCell: hidden },
  { title: '台数', key: 'qty', width: 100, align: 'right' as const, customCell: hidden },
  { title: '状态', key: 'state', width: 120, align: 'right' as const, customCell: hidden },
]
const customRow = (r: Row) => (r.kind === 'group' ? { id: r.id, class: ['wk-group', r.current ? 'current' : ''] } : {})

const root = ref<HTMLElement | null>(null)
function scrollToFocus() {
  const f = props.focus
  if (!f || !root.value) return
  const el = root.value.querySelector<HTMLElement>(`#wk-${periodOf('week', f).start}`)
  el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
onMounted(() => nextTick(scrollToFocus))
watch(() => [props.focus, props.start], () => nextTick(scrollToFocus))
</script>

<template>
  <UiSectionCard padding="none">
    <div ref="root">
      <a-table class="ft-table" :columns="columns" :data-source="rows" row-key="key" :pagination="false" :custom-row="customRow" :scroll="{ x: 640 }" size="middle">
        <template #bodyCell="{ column, record }">
          <template v-if="record.kind === 'group'">
            <span v-if="column.key === 'day'" class="g">
              <span class="g-title">{{ record.title }}<span class="g-range">{{ record.range }}</span></span>
              <span class="g-sum">{{ record.orders }} 单 · 共 <b>{{ record.units }}</b> 台</span>
            </span>
          </template>
          <template v-else-if="record.kind === 'empty'">
            <span v-if="column.key === 'day'" class="empty">这周没有计划完成的工单</span>
          </template>
          <template v-else>
            <span v-if="column.key === 'day'" class="date">{{ md(record.e.day) }} {{ weekdayOf(record.e.day) }}</span>
            <NuxtLink v-else-if="column.key === 'no'" :to="record.e.to">{{ record.e.no }}</NuxtLink>
            <span v-else-if="column.key === 'product'">{{ record.e.product || '—' }}</span>
            <span v-else-if="column.key === 'qty'" class="qty">{{ record.e.qty > 0 ? record.e.qty : '?' }}<small>台</small></span>
            <UiStatusTag v-else-if="column.key === 'state'" :tone="STATE_TONE[record.e.state as CompletionState]">{{ COMPLETION_STATE_TEXT[record.e.state as CompletionState] }}</UiStatusTag>
          </template>
        </template>
      </a-table>
    </div>
  </UiSectionCard>
</template>

<style scoped>
.date { color: var(--ft-text-2); font-variant-numeric: tabular-nums; }
.qty { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
.qty small { margin-left: 2px; font-size: 12px; font-weight: 400; color: var(--ft-text-2); }
.empty { font-size: 13px; color: var(--ft-text-2); }
.g { display: flex; align-items: baseline; gap: 12px; }
.g-title { flex: 1; font-size: 15px; font-weight: 600; color: var(--ft-text); }
.g-range { margin-left: 12px; font-size: 13px; font-weight: 400; color: var(--ft-text-2); }
.g-sum { font-size: 13px; color: var(--ft-text-2); white-space: nowrap; }
.g-sum b { font-size: 18px; color: var(--ft-text); }
:deep(.wk-group) { scroll-margin-top: 16px; }
:deep(.wk-group > td) { background: var(--ft-fill); }
:deep(.wk-group.current > td) { background: var(--ft-primary-bg); }
:deep(.ant-table-tbody > tr.wk-group:hover > td) { background: var(--ft-fill); }
:deep(.ant-table-tbody > tr.wk-group.current:hover > td) { background: var(--ft-primary-bg); }
</style>
