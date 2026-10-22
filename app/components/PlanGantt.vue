<script setup lang="ts">
/**
 * 总计划甘特视图（只读，10-22）：按阶段分组，每个节点一行横道，和项目部 MS Project 打印的计划对得上。
 *   横道 = 计划开始日 ~ 计划完成日（没有开始日的画成菱形里程碑）；关键节点（余量 ≤ 0）实心，其余浅色；已完成为绿色；
 *   没完成且预计晚于计划的，在横道后面接一段红色斜纹到预计完成日；虚线 = 今天，实线 = 合同交期。
 *   前置关系不画连线（节点多了线会乱），节点名右边写"前置 #3 #8"。改计划在"表格"视图里改。
 */
interface GNode {
  id: string
  seq: number
  name: string
  deptText: string
  phase: string | null
  startDate: string | null
  planDate: string
  baselineDate: string | null
  expectedDate: string
  actualDate: string | null
  done: boolean
  delayDays: number
  critical: boolean
  slackDays: number | null
  customDeps: boolean
  preds: { id: string; seq: number }[]
}
const props = defineProps<{ nodes: GNode[]; deliveryDate: string | null; today: string }>()
const emit = defineEmits<{ select: [id: string] }>()

const DAY = 86_400_000
const t = (d: string) => Date.parse(`${d}T00:00:00.000Z`)
const range = computed(() => {
  const days: number[] = [t(props.today)]
  for (const n of props.nodes) {
    days.push(t(n.startDate ?? n.planDate), t(n.planDate), t(n.expectedDate))
    if (n.actualDate) days.push(t(n.actualDate))
    if (n.baselineDate) days.push(t(n.baselineDate))
  }
  if (props.deliveryDate) days.push(t(props.deliveryDate))
  const min = Math.min(...days) - 3 * DAY
  const max = Math.max(...days) + 4 * DAY
  return { min, span: max - min }
})
/** 某天的左边位置（%）；end = true 取当天结束 */
const pos = (d: string, end = false) => ((t(d) + (end ? DAY : 0) - range.value.min) / range.value.span) * 100
const pct = (v: number) => `${Math.max(0, Math.min(100, v)).toFixed(3)}%`

/** 月份刻度：每月 1 号一条线；跨度短于 45 天时再加每周一 */
const ticks = computed(() => {
  const out: { left: string; label: string; month: boolean }[] = []
  const { min, span } = range.value
  const start = new Date(min)
  const short = span < 45 * DAY
  for (let d = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()); d <= min + span; d += DAY) {
    const x = new Date(d)
    const month = x.getUTCDate() === 1
    if (month || (short && x.getUTCDay() === 1)) out.push({ left: pct(((d - min) / span) * 100), label: month ? `${x.getUTCMonth() + 1}月` : `${x.getUTCMonth() + 1}/${x.getUTCDate()}`, month })
  }
  return out
})

type Row = { kind: 'phase'; key: string; phase: string; start: string; end: string; count: number; done: number } | { kind: 'node'; key: string; n: GNode }
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const anyPhase = props.nodes.some((n) => n.phase)
  let cur: string | null | undefined
  for (const n of props.nodes) {
    const ph = n.phase ?? null
    if (anyPhase && ph !== cur) {
      const group: GNode[] = []
      for (const m of props.nodes.slice(props.nodes.indexOf(n))) {
        if ((m.phase ?? null) !== ph) break
        group.push(m)
      }
      const starts = group.map((m) => m.startDate ?? m.planDate).sort()
      const ends = group.map((m) => m.planDate).sort()
      out.push({ kind: 'phase', key: `ph:${n.id}`, phase: ph ?? '未分阶段', start: starts[0]!, end: ends.at(-1)!, count: group.length, done: group.filter((m) => m.done).length })
      cur = ph
    }
    out.push({ kind: 'node', key: n.id, n })
  }
  return out
})

const isMilestone = (n: GNode) => !n.startDate || n.startDate === n.planDate
function barStyle(n: GNode) {
  const l = pos(n.startDate ?? n.planDate)
  return { left: pct(l), width: pct(Math.max(0.5, pos(n.planDate, true) - l)) }
}
const lateStyle = (n: GNode) => ({ left: pct(pos(n.planDate, true)), width: pct(pos(n.expectedDate, true) - pos(n.planDate, true)) })
const baseStyle = (n: GNode) => {
  const dur = n.startDate ? (t(n.planDate) - t(n.startDate)) / DAY : 0
  const l = pos(n.baselineDate!) - (dur / range.value.span) * DAY * 100
  return { left: pct(l), width: pct(Math.max(0.5, pos(n.baselineDate!, true) - l)) }
}
function tip(n: GNode) {
  const parts = [`#${n.seq} ${n.name}（${n.deptText}）`, `计划 ${n.startDate ? `${n.startDate} ~ ` : ''}${n.planDate}`]
  if (n.baselineDate && n.baselineDate !== n.planDate) parts.push(`基线 ${n.baselineDate}`)
  if (n.done) parts.push(`已完成 ${n.actualDate}`)
  else {
    parts.push(`预计 ${n.expectedDate}${n.delayDays > 0 ? `（晚 ${n.delayDays} 天）` : ''}`)
    if (n.slackDays != null) parts.push(n.slackDays <= 0 ? '关键节点：再晚就拖交期' : `余量 ${n.slackDays} 天`)
  }
  if (n.preds.length) parts.push(`前置 ${n.preds.map((p) => `#${p.seq}`).join(' ')}`)
  return parts.join('\n')
}
const todayLeft = computed(() => pct(pos(props.today)))
const deliveryLeft = computed(() => (props.deliveryDate ? pct(pos(props.deliveryDate, true)) : null))
</script>

<template>
  <div class="gantt-scroll">
    <div class="gantt" role="table" aria-label="总计划甘特图">
      <div class="g-row g-head" role="row">
        <div class="g-label" role="columnheader">节点</div>
        <div class="g-track" role="columnheader">
          <span v-for="k in ticks" :key="k.left" class="tick-label" :class="{ week: !k.month }" :style="{ left: k.left }">{{ k.label }}</span>
        </div>
      </div>
      <div class="g-body">
        <div class="g-lines" aria-hidden="true">
          <span v-for="k in ticks" :key="k.left" class="tick" :class="{ week: !k.month }" :style="{ left: k.left }" />
          <span class="today" :style="{ left: todayLeft }"><em>今天</em></span>
          <span v-if="deliveryLeft" class="delivery" :style="{ left: deliveryLeft }"><em>合同交期</em></span>
        </div>
        <template v-for="r in rows" :key="r.key">
          <div v-if="r.kind === 'phase'" class="g-row g-phase" role="row">
            <div class="g-label" role="cell">
              <span class="phase-name">{{ r.phase }}</span>
              <span class="muted">{{ r.done }}/{{ r.count }}</span>
            </div>
            <div class="g-track" role="cell">
              <span class="phase-bar" :style="{ left: pct(pos(r.start)), width: pct(pos(r.end, true) - pos(r.start)) }" :title="`${r.phase}：${r.start} ~ ${r.end}`" />
            </div>
          </div>
          <div v-else class="g-row" role="row" :aria-label="tip(r.n)">
            <button type="button" class="g-label node-label" role="cell" :title="tip(r.n)" @click="emit('select', r.n.id)">
              <span class="seq">{{ r.n.seq }}</span>
              <span class="name">{{ r.n.name }}</span>
              <span class="meta">
                <template v-if="r.n.preds.length && r.n.customDeps">前置 {{ r.n.preds.map((p) => `#${p.seq}`).join(' ') }}</template>
                <template v-else>{{ r.n.deptText }}</template>
              </span>
            </button>
            <div class="g-track" role="cell" :title="tip(r.n)">
              <span v-if="r.n.baselineDate && r.n.baselineDate !== r.n.planDate" class="baseline" :style="baseStyle(r.n)" />
              <span v-if="isMilestone(r.n)" class="milestone" :class="{ done: r.n.done, critical: r.n.critical }" :style="{ left: pct(pos(r.n.planDate) + (pos(r.n.planDate, true) - pos(r.n.planDate)) / 2) }" />
              <span v-else class="bar" :class="{ done: r.n.done, critical: r.n.critical && !r.n.done }" :style="barStyle(r.n)" />
              <span v-if="!r.n.done && r.n.delayDays > 0" class="late" :style="lateStyle(r.n)" />
            </div>
          </div>
        </template>
      </div>
    </div>
    <div class="legend">
      <span><i class="lg bar" />计划</span>
      <span><i class="lg bar critical" />关键节点（再晚就拖交期）</span>
      <span><i class="lg bar done" />已完成</span>
      <span><i class="lg late" />预计延误</span>
      <span><i class="lg milestone" />里程碑</span>
      <span><i class="lg today" />今天</span>
      <span><i class="lg delivery" />合同交期</span>
      <span><i class="lg baseline" />基线（改过日期的）</span>
    </div>
  </div>
</template>

<style scoped>
.gantt-scroll { overflow-x: auto; }
.gantt { min-width: 860px; font-size: 13px; }
.g-row { display: grid; grid-template-columns: 260px 1fr; min-height: 30px; align-items: center; border-bottom: 1px solid var(--ft-border); }
.g-head { min-height: 28px; color: var(--ft-text-2); font-size: 12px; }
.g-label { padding: 0 8px 0 4px; display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; }
.node-label { background: none; border: 0; text-align: left; cursor: pointer; font: inherit; color: var(--ft-text); height: 100%; width: 100%; }
.node-label:hover .name { color: var(--ft-primary); }
.node-label:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: -2px; }
.seq { width: 20px; flex: none; text-align: right; color: var(--ft-text-3); }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { flex: none; color: var(--ft-text-2); font-size: 12px; }
.g-track { position: relative; height: 100%; min-height: 28px; }
.g-body { position: relative; }
.g-lines { position: absolute; inset: 0 0 0 260px; pointer-events: none; }
.tick { position: absolute; top: 0; bottom: 0; border-left: 1px solid var(--ft-border); }
.tick.week { border-left-style: dotted; }
.tick-label { position: absolute; top: 6px; transform: translateX(4px); white-space: nowrap; }
.tick-label.week { color: var(--ft-text-3); }
.today { position: absolute; top: 0; bottom: 0; border-left: 1px dashed var(--ft-primary); z-index: 1; }
.delivery { position: absolute; top: 0; bottom: 0; border-left: 2px solid var(--ft-text-2); z-index: 1; }
.today em, .delivery em { position: absolute; bottom: 2px; left: 3px; font-style: normal; font-size: 11px; white-space: nowrap; color: var(--ft-text-2); background: var(--ft-card-bg); padding: 0 2px; }
.g-phase { background: var(--ft-fill); }
.phase-name { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muted { color: var(--ft-text-2); font-size: 12px; }
.phase-bar { position: absolute; top: 50%; height: 6px; margin-top: -3px; background: var(--ft-text-2); border-radius: 1px; }
.bar { position: absolute; top: 50%; height: 14px; margin-top: -7px; border-radius: 3px; background: var(--ft-primary-bg); border: 1px solid var(--ft-primary); z-index: 2; }
.bar.critical { background: var(--ft-primary); }
.bar.done { background: var(--ft-done); border-color: var(--ft-done); }
.late { position: absolute; top: 50%; height: 14px; margin-top: -7px; border-radius: 0 3px 3px 0; z-index: 2;
  background: repeating-linear-gradient(135deg, var(--ft-late) 0 3px, var(--ft-late-bg) 3px 6px); border: 1px solid var(--ft-late); border-left: 0; }
.milestone { position: absolute; top: 50%; width: 11px; height: 11px; margin: -6px 0 0 -6px; transform: rotate(45deg); background: var(--ft-card-bg); border: 2px solid var(--ft-primary); z-index: 3; }
.milestone.critical { background: var(--ft-primary); }
.milestone.done { background: var(--ft-done); border-color: var(--ft-done); }
.baseline { position: absolute; top: 50%; height: 3px; margin-top: 9px; background: var(--ft-text-3); border-radius: 1px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 10px; font-size: 12px; color: var(--ft-text-2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.lg { display: inline-block; width: 18px; height: 10px; border-radius: 2px; position: relative; }
.lg.bar { position: relative; top: 0; margin: 0; height: 10px; }
.lg.late { background: repeating-linear-gradient(135deg, var(--ft-late) 0 3px, var(--ft-late-bg) 3px 6px); border: 1px solid var(--ft-late); }
.lg.milestone { width: 9px; height: 9px; margin: 0 3px; transform: rotate(45deg); position: relative; top: 0; border-width: 2px; }
.lg.today { width: 0; height: 12px; border-left: 1px dashed var(--ft-primary); border-radius: 0; }
.lg.delivery { width: 0; height: 12px; border-left: 2px solid var(--ft-text-2); border-radius: 0; }
.lg.baseline { height: 3px; background: var(--ft-text-3); }
</style>
