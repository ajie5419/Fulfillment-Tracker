<script setup lang="ts">
/**
 * 项目日历格子：周一到周日 7 列。月视图每格最多显示 MONTH_MAX 条，多的点"还有 N 项"展开；周视图每条两行（标题 + 说明）、全部显示。
 * 月视图每条最多两行，超出省略（完整内容在悬停提示里）。窄屏（< 992px）改成按日期分组的列表，只列有内容的日子。
 * 状态同时给图标形状和文字（title / aria-label），不只靠颜色。颜色走 --ft-* 变量。
 */
import type { CalendarView } from '#shared/calendar'

export interface CalendarEntry {
  key: string
  day: string
  tone: 'late' | 'risk' | 'done' | 'upstream' | 'none' | 'primary'
  stateText: string
  title: string
  sub?: string
  to: string
  /** 发运节点 / 交期：加粗显示 */
  strong?: boolean
}

const props = defineProps<{ view: CalendarView; days: string[]; start: string; end: string; today: string; entries: CalendarEntry[] }>()

const MONTH_MAX = 4
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const ICON = { late: 'alert', risk: 'warn', upstream: 'warn', done: 'check', primary: 'dot', none: 'ring' } as const

const byDay = computed(() => {
  const m = new Map<string, CalendarEntry[]>()
  for (const e of props.entries) m.set(e.day, [...(m.get(e.day) ?? []), e])
  return m
})
const expanded = ref(new Set<string>())
watch(() => [props.view, props.start], () => (expanded.value = new Set()))
function shown(day: string) {
  const all = byDay.value.get(day) ?? []
  return props.view === 'month' && !expanded.value.has(day) ? all.slice(0, MONTH_MAX) : all
}
const hidden = (day: string) => (props.view === 'month' && !expanded.value.has(day) ? Math.max(0, (byDay.value.get(day)?.length ?? 0) - MONTH_MAX) : 0)
function expand(day: string) {
  expanded.value = new Set([...expanded.value, day])
}
const inside = (d: string) => d >= props.start && d <= props.end
const dayNum = (d: string) => Number(d.slice(8, 10))
const weekdayOf = (d: string) => WEEKDAYS[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7]
const listDays = computed(() => props.days.filter((d) => inside(d) && byDay.value.has(d)))
const label = (e: CalendarEntry) => `${e.title}${e.sub ? `，${e.sub}` : ''}，${e.stateText}`
</script>

<template>
  <div class="cal" :class="`v-${view}`">
    <div class="grid" role="group" :aria-label="view === 'week' ? '周日历' : '月日历'">
      <div class="row head" aria-hidden="true"><div v-for="w in WEEKDAYS" :key="w" class="dow">{{ w }}</div></div>
      <div class="row">
        <div v-for="d in days" :key="d" class="cell" :class="{ out: !inside(d), today: d === today }">
          <div class="date"><span>{{ dayNum(d) }}</span><span v-if="d === today" class="today-tag">今天</span></div>
          <template v-if="inside(d)">
            <NuxtLink v-for="e in shown(d)" :key="e.key" :to="e.to" class="ev" :class="{ strong: e.strong }" :title="label(e)" :aria-label="label(e)">
              <UiStatusIcon :kind="ICON[e.tone]" :tone="e.tone" :size="12" class="ev-icon" />
              <span class="ev-body">
                <span class="ev-title">{{ e.title }}</span>
                <span v-if="view === 'week' && e.sub" class="ev-sub">{{ e.sub }}</span>
                <span v-if="view === 'week'" class="ev-sub">{{ e.stateText }}</span>
              </span>
            </NuxtLink>
            <button v-if="hidden(d)" type="button" class="more" @click="expand(d)">还有 {{ hidden(d) }} 项</button>
          </template>
        </div>
      </div>
    </div>

    <div class="list">
      <div v-for="d in listDays" :key="d" class="list-day">
        <div class="list-date">{{ d.slice(5) }} {{ weekdayOf(d) }}<span v-if="d === today" class="today-tag">今天</span></div>
        <NuxtLink v-for="e in byDay.get(d)" :key="e.key" :to="e.to" class="ev" :class="{ strong: e.strong }" :aria-label="label(e)">
          <UiStatusIcon :kind="ICON[e.tone]" :tone="e.tone" :size="12" class="ev-icon" />
          <span class="ev-body">
            <span class="ev-title">{{ e.title }}</span>
            <span class="ev-sub">{{ e.sub ? `${e.sub} · ` : '' }}{{ e.stateText }}</span>
          </span>
        </NuxtLink>
      </div>
      <a-empty v-if="!listDays.length" description="这一期没有到期的节点" />
    </div>
  </div>
</template>

<style scoped>
.grid { border: 1px solid var(--ft-border); border-radius: 12px; overflow: hidden; }
.row { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
.head { background: var(--ft-fill); }
.dow { padding: 8px 10px; font-size: 12px; color: var(--ft-text-2); }
.cell { min-height: 112px; padding: 6px 6px 8px; border-top: 1px solid var(--ft-border); border-left: 1px solid var(--ft-border); display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cell:nth-child(7n + 1) { border-left: 0; }
.v-week .cell { min-height: 360px; }
.cell.out { background: var(--ft-fill); }
.cell.out .date { color: var(--ft-text-2); font-weight: normal; }
.date { display: flex; align-items: center; gap: 6px; padding: 0 4px 2px; font-size: 13px; font-weight: 600; color: var(--ft-text); }
.today-tag { padding: 0 6px; border-radius: 8px; background: var(--ft-primary-bg); color: var(--ft-primary-text); font-size: 11px; font-weight: 500; line-height: 18px; }
.cell.today .date > span:first-child { color: var(--ft-primary-text); }
.ev { display: flex; align-items: flex-start; gap: 5px; padding: 2px 4px; border-radius: 6px; color: var(--ft-text); font-size: 12px; line-height: 18px; min-width: 0; }
.ev:hover { background: var(--ft-fill); color: var(--ft-text); }
.ev:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 1px; }
.ev-icon { flex: none; margin-top: 3px; }
.ev-body { display: flex; flex-direction: column; min-width: 0; }
.ev-title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; word-break: break-all; }
.v-week .ev-title, .list .ev-title { display: block; }
.ev.strong .ev-title { font-weight: 600; }
.ev-sub { font-size: 12px; color: var(--ft-text-2); }
.v-week .ev { padding: 4px; }
.v-week .ev + .ev { border-top: 1px dashed var(--ft-border); border-radius: 0; }
.more { align-self: flex-start; margin: 2px 4px 0; padding: 0; border: 0; background: none; color: var(--ft-primary-text); font-size: 12px; cursor: pointer; }
.more:focus-visible { outline: 2px solid var(--ft-primary); }

.list { display: none; }
.list-day + .list-day { margin-top: 12px; }
.list-date { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 13px; font-weight: 600; color: var(--ft-text); }
.list .ev { padding: 6px 4px; }

@media (max-width: 991px) {
  .grid { display: none; }
  .list { display: block; }
}
</style>
