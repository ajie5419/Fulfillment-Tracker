<script setup lang="ts">
/**
 * 项目日历 · 日历显示（zhao 10-21 第三轮选的方案 A）：左边月格，右边是选中那天的工单。
 * 每格是一个按钮，只放日期和当天合计（大号台数 + "台 · N 单"）；有逾期的合计标红并加红色"!"图标（形状区分，不只靠颜色）。
 * 点格子在右边卡片里列出当天的工单，逾期的工单带"逾期"标签。
 * 窄屏（< 992px）右边卡片挪到月格下面。颜色只用 --ft-* 变量。
 */
import type { CompletionState } from '#shared/calendar'

export interface CalendarEntry {
  key: string
  /** 计划完成日 */
  day: string
  /** 工单号 */
  no: string
  /** 产品名称（QMS 项目名称） */
  product: string
  /** 台数；0 = QMS 没填 */
  qty: number
  state: CompletionState
  to: string
}

const props = defineProps<{ days: string[]; start: string; end: string; today: string; entries: CalendarEntry[]; selected: string }>()
const emit = defineEmits<{ 'update:selected': [day: string] }>()

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

const byDay = computed(() => {
  const m = new Map<string, CalendarEntry[]>()
  for (const e of props.entries) m.set(e.day, [...(m.get(e.day) ?? []), e])
  return m
})
const inside = (d: string) => d >= props.start && d <= props.end
const dayNum = (d: string) => Number(d.slice(8, 10))
const qtyOf = (e: CalendarEntry) => Math.max(0, e.qty)
const late = (e: CalendarEntry) => e.state === 'OVERDUE'
function total(day: string) {
  const all = byDay.value.get(day) ?? []
  return { units: all.reduce((n, e) => n + qtyOf(e), 0), orders: all.length, late: all.some(late) }
}
function cellLabel(d: string) {
  const t = total(d)
  const base = `${Number(d.slice(5, 7))}月${dayNum(d)}日${d === props.today ? '（今天）' : ''}`
  return t.orders ? `${base}，计划完成 ${t.units} 台、${t.orders} 单${t.late ? '，有逾期' : ''}` : `${base}，没有工单`
}

const selItems = computed(() => byDay.value.get(props.selected) ?? [])
const selTitle = computed(() => `${Number(props.selected.slice(5, 7))}月${dayNum(props.selected)}日${props.selected === props.today ? '（今天）' : ''}`)
const selUnits = computed(() => selItems.value.reduce((n, e) => n + qtyOf(e), 0))
</script>

<template>
  <div class="cal-a">
    <UiSectionCard padding="none">
      <div class="grid" role="group" aria-label="月日历，点日子看当天的工单">
        <div v-for="w in WEEKDAYS" :key="w" class="dow" aria-hidden="true">{{ w }}</div>
        <template v-for="d in days" :key="d">
          <button
            v-if="inside(d)"
            type="button"
            class="cell"
            :class="{ sel: d === selected, today: d === today }"
            :aria-pressed="d === selected"
            :aria-label="cellLabel(d)"
            @click="emit('update:selected', d)"
          >
            <span class="num">{{ dayNum(d) }}</span>
            <span v-if="byDay.has(d)" class="tot">
              <b :class="{ late: total(d).late }">{{ total(d).units }}</b><UiStatusIcon v-if="total(d).late" kind="alert" tone="late" :size="14" class="late-icon" /><small>台 · {{ total(d).orders }} 单</small>
            </span>
          </button>
          <div v-else class="cell out" aria-hidden="true"><span class="num">{{ dayNum(d) }}</span></div>
        </template>
      </div>
    </UiSectionCard>

    <UiSectionCard class="detail">
      <template #title>{{ selTitle }}</template>
      <template #extra><span class="sel-total">共 <b>{{ selUnits }}</b> 台</span></template>
      <div v-for="e in selItems" :key="e.key" class="row">
        <span class="row-main">
          <NuxtLink :to="e.to" class="no">{{ e.no }}</NuxtLink>
          <span class="product">{{ e.product || '—' }}</span>
        </span>
        <UiStatusTag v-if="late(e)" tone="late">逾期</UiStatusTag>
        <b class="qty" :class="{ late: late(e) }">{{ e.qty > 0 ? e.qty : '?' }}<small>台</small></b>
      </div>
      <div v-if="!selItems.length" class="empty">这天没有计划完成的工单</div>
    </UiSectionCard>
  </div>
</template>

<style scoped>
.cal-a { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; align-items: start; }

.grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
.dow { padding: 10px 12px; font-size: 12px; color: var(--ft-text-2); }
.cell { all: unset; box-sizing: border-box; height: 96px; padding: 10px 12px; border-top: 1px solid var(--ft-border); border-left: 1px solid var(--ft-border); display: flex; flex-direction: column; justify-content: space-between; min-width: 0; background: var(--ft-card-bg); cursor: pointer; }
/* 每行第一格（星期表头占了前 7 个位置）不要左边线 */
.grid > :nth-child(7n + 8) { border-left: 0; }
.cell:hover { background: var(--ft-fill); }
.cell:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: -2px; }
.cell.sel { background: var(--ft-primary-bg); }
.cell.out { background: var(--ft-fill); cursor: default; }
.num { font-size: 13px; color: var(--ft-text-2); font-variant-numeric: tabular-nums; }
.cell.out .num { color: var(--ft-text-3); }
.cell.today .num { color: var(--ft-primary-text); font-weight: 700; }
.tot { display: flex; align-items: baseline; gap: 6px; min-width: 0; white-space: nowrap; }
.tot b { font-size: 22px; line-height: 26px; font-weight: 700; color: var(--ft-text); font-variant-numeric: tabular-nums; }
.tot small { font-size: 12px; color: var(--ft-text-2); overflow: hidden; text-overflow: ellipsis; }
.tot b.late, .qty.late { color: var(--ft-late-text); }
.late-icon { align-self: center; margin-left: -2px; }

.sel-total { font-size: 13px; color: var(--ft-text-2); }
.sel-total b { font-size: 18px; color: var(--ft-text); }
.row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--ft-border); }
.row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.no { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.no:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; }
.product { font-size: 12px; color: var(--ft-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qty { flex: none; font-size: 18px; color: var(--ft-text); font-variant-numeric: tabular-nums; }
.qty small { margin-left: 2px; font-size: 12px; font-weight: 400; color: var(--ft-text-2); }
.empty { padding: 24px 0; border-top: 1px solid var(--ft-border); font-size: 13px; color: var(--ft-text-2); }

@media (max-width: 991px) {
  .cal-a { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 767px) {
  .cell { height: 64px; padding: 6px 8px; }
  .dow { padding: 8px; }
  .tot b { font-size: 18px; line-height: 22px; }
  .tot small { display: none; }
}
</style>
