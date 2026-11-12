<script setup lang="ts">
/**
 * 总计划同屏甘特视图（Brick 风格，只读）：
 * 外层采用「浅灰圆角大托盘（Project Tray）+ 纯白内嵌卡（Inset Card）」三层结构；
 * 左侧固定 4 列精简表（节点/任务名称、责任部门/人、完成进度、计划起止），右侧无缝拼接日历时间轴与 SVG 依赖连线。
 */
interface GNode {
  id: string
  seq: number
  code: string
  parentId: string | null
  childCount?: number
  name: string
  deptText: string
  confirmedByName?: string | null
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
  taskCount?: number
  doneCount?: number
  overdueCount?: number
  dateConflict?: boolean
  preds: { id: string; seq: number; code: string; name?: string }[]
}
const props = withDefaults(
  defineProps<{
    nodes: GNode[]
    deliveryDate: string | null
    today: string
    wo?: string
    projectName?: string | null
  }>(),
  { wo: '', projectName: null },
)
const emit = defineEmits<{ select: [id: string] }>()

const DAY = 86_400_000
const ROW_H = 38
const SVG_W = 1000
const SHORT_SPAN_DAYS = 45
const MID_MONTH_DAY = 15
const COMPACT_ROW_SPAN = 4

const hoverId = ref<string | null>(null)

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
  const max = Math.max(...days) + 5 * DAY
  return { min, span: Math.max(DAY, max - min) }
})
/** 某天的左边位置（0~100%）；end = true 取当天结束 */
const pos = (d: string, end = false) => ((t(d) + (end ? DAY : 0) - range.value.min) / range.value.span) * 100
const clampPct = (v: number) => Math.max(0, Math.min(100, v))
const pct = (v: number) => `${clampPct(v).toFixed(3)}%`

/** 时间刻度：每月 1 号主刻度线；跨度短于 45 天加每周一，否则加每月 15 号半月次刻度线 */
const ticks = computed(() => {
  const out: { left: string; label: string; major: boolean }[] = []
  const { min, span } = range.value
  const start = new Date(min)
  const short = span < SHORT_SPAN_DAYS * DAY
  for (let d = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()); d <= min + span; d += DAY) {
    const x = new Date(d)
    const date = x.getUTCDate()
    const month = date === 1
    const minor = short ? x.getUTCDay() === 1 : date === MID_MONTH_DAY
    if (month || minor) {
      const m = x.getUTCMonth() + 1
      const label = month ? (m === 1 ? `${x.getUTCFullYear()}年1月` : `${m}月`) : `${m}/${date}`
      out.push({ left: pct(((d - min) / span) * 100), label, major: month })
    }
  }
  return out
})

const leafNodes = computed(() => {
  const leaves = props.nodes.filter((n) => !(n.childCount && n.childCount > 0))
  return leaves.length ? leaves : props.nodes
})
const doneLeafCount = computed(() => leafNodes.value.filter((n) => n.done).length)
const totalLeafCount = computed(() => leafNodes.value.length)
const overallPct = computed(() => (totalLeafCount.value ? Math.round((doneLeafCount.value / totalLeafCount.value) * 100) : 0))

type PhaseRow = { kind: 'phase'; key: string; code: string; phase: string; start: string; end: string; count: number; done: number }
type NodeRow = { kind: 'node'; key: string; n: GNode; isSummary: boolean; isLastChild: boolean }
type Row = PhaseRow | NodeRow

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const anyPhase = props.nodes.some((n) => n.phase)
  let cur: string | null | undefined
  let phaseSeq = 0
  for (const [i, n] of props.nodes.entries()) {
    const ph = n.phase ?? null
    if (anyPhase && ph !== cur) {
      phaseSeq++
      const group: GNode[] = []
      for (const m of props.nodes.slice(i)) {
        if ((m.phase ?? null) !== ph) break
        group.push(m)
      }
      const leaves = group.filter((m) => !m.childCount)
      const pool = leaves.length ? leaves : group
      const starts = pool.map((m) => m.startDate ?? m.planDate).sort()
      const ends = pool.map((m) => m.planDate).sort()
      const start = starts[0] ?? n.planDate
      const end = ends.at(-1) ?? n.planDate
      out.push({
        kind: 'phase',
        key: `ph:${n.id}`,
        code: String(phaseSeq),
        phase: ph ?? '未分阶段',
        start,
        end,
        count: pool.length,
        done: pool.filter((m) => m.done).length,
      })
      cur = ph
    }
    const next = props.nodes[i + 1]
    const isLastChild = !!n.parentId && (!next || next.parentId !== n.parentId)
    out.push({ kind: 'node', key: n.id, n, isSummary: (n.childCount ?? 0) > 0, isLastChild })
  }
  return out
})

const isMilestone = (n: GNode) => !(n.childCount && n.childCount > 0) && (!n.startDate || n.startDate === n.planDate)

function nodeProgress(n: GNode): number {
  if (n.done) return 100
  if (n.taskCount && n.taskCount > 0) return Math.round(((n.doneCount ?? 0) / n.taskCount) * 100)
  return 0
}

function nodeAlertLevel(n: GNode): 'late' | 'risk' | null {
  if (n.done) return null
  if (n.delayDays > 0 || (n.overdueCount ?? 0) > 0) return 'late'
  if (n.dateConflict || n.critical) return 'risk'
  return null
}

function shortRange(start: string | null, end: string): string {
  const e = end.length === 10 ? end.slice(5) : end
  if (!start || start === end) return e
  const s = start.length === 10 ? start.slice(5) : start
  return s.slice(0, 2) === e.slice(0, 2) ? `${s} ~ ${e.slice(3)}` : `${s} ~ ${e}`
}

function barStyle(n: GNode) {
  const l = pos(n.startDate ?? n.planDate)
  return { left: pct(l), width: pct(Math.max(0.8, pos(n.planDate, true) - l)) }
}
const lateStyle = (n: GNode) => ({ left: pct(pos(n.planDate, true)), width: pct(Math.max(0.4, pos(n.expectedDate, true) - pos(n.planDate, true))) })
const baseStyle = (n: GNode) => {
  const base = n.baselineDate ?? n.planDate
  const dur = n.startDate ? (t(n.planDate) - t(n.startDate)) / DAY : 0
  const l = pos(base) - (dur / range.value.span) * DAY * 100
  return { left: pct(l), width: pct(Math.max(0.5, pos(base, true) - l)) }
}

/** 节点右侧前置短标签：显示前置编号，让用户不悬停也能直接看到前置来源 */
function predBadgeText(n: GNode): string | null {
  if ((n.childCount ?? 0) > 0 || !n.preds.length) return null
  if (n.preds.length <= 2) return `← ${n.preds.map((p) => p.code).join('、')}`
  const head = n.preds.slice(0, 2).map((p) => p.code).join('、')
  return `← ${head} 等${n.preds.length}项`
}

function barEndLeft(n: GNode): string {
  const endDate = !n.done && n.delayDays > 0 && n.expectedDate > n.planDate ? n.expectedDate : n.planDate
  return pct(pos(endDate, true))
}

/** 计算前置依赖连线（SVG 坐标系：X 为 0~1000，Y 为像素行中心） */
interface DepEdge {
  key: string
  fromId: string
  toId: string
  path: string
  arrowX: number
  arrowY: number
  critical: boolean
  compact: boolean
  active: boolean
  dimmed: boolean
}

const rowIndexByNodeId = computed(() => {
  const map = new Map<string, { idx: number; node: GNode }>()
  rows.value.forEach((r, idx) => {
    if (r.kind === 'node') map.set(r.n.id, { idx, node: r.n })
  })
  return map
})

const relatedIds = computed(() => {
  const active = hoverId.value
  if (!active) return null
  const set = new Set<string>([active])
  for (const n of props.nodes) {
    if (n.id === active) {
      for (const p of n.preds) set.add(p.id)
    } else if (n.preds.some((p) => p.id === active)) {
      set.add(n.id)
    }
  }
  return set
})

const depEdges = computed<DepEdge[]>(() => {
  const map = rowIndexByNodeId.value
  const active = hoverId.value
  const edges: DepEdge[] = []
  for (const r of rows.value) {
    if (r.kind !== 'node' || r.isSummary) continue
    const to = r.n
    const toEntry = map.get(to.id)
    if (!toEntry) continue
    for (const p of to.preds) {
      const fromEntry = map.get(p.id)
      if (!fromEntry) continue
      const from = fromEntry.node
      const x1 = (clampPct(pos(from.planDate, true)) / 100) * SVG_W
      const y1 = fromEntry.idx * ROW_H + ROW_H / 2
      const toStart = isMilestone(to)
        ? pos(to.planDate) + (pos(to.planDate, true) - pos(to.planDate)) / 2
        : pos(to.startDate ?? to.planDate)
      const x2 = (clampPct(toStart) / 100) * SVG_W
      const y2 = toEntry.idx * ROW_H + ROW_H / 2

      const rowDist = Math.abs(toEntry.idx - fromEntry.idx)
      const critical = from.critical && to.critical && !from.done && !to.done
      const compact = rowDist <= COMPACT_ROW_SPAN
      const isEdgeActive = active === from.id || active === to.id
      const isDimmed = !!active && !isEdgeActive

      let path = ''
      if (x2 >= x1 + 4) {
        const midX = x1 + Math.min(10, Math.max(3, (x2 - x1) * 0.4))
        path = `M ${x1.toFixed(1)} ${y1} L ${midX.toFixed(1)} ${y1} L ${midX.toFixed(1)} ${y2} L ${x2.toFixed(1)} ${y2}`
      } else {
        const dir = y2 >= y1 ? 1 : -1
        const detY = y1 + dir * (ROW_H * 0.45)
        const leftX = Math.max(4, x2 - 8)
        path = `M ${x1.toFixed(1)} ${y1} L ${(x1 + 5).toFixed(1)} ${y1} L ${(x1 + 5).toFixed(1)} ${detY.toFixed(1)} L ${leftX.toFixed(1)} ${detY.toFixed(1)} L ${leftX.toFixed(1)} ${y2} L ${x2.toFixed(1)} ${y2}`
      }
      edges.push({
        key: `${from.id}->${to.id}`,
        fromId: from.id,
        toId: to.id,
        path,
        arrowX: x2,
        arrowY: y2,
        critical,
        compact,
        active: isEdgeActive,
        dimmed: isDimmed,
      })
    }
  }
  return edges.sort((a, b) => Number(a.active) - Number(b.active) || Number(a.critical) - Number(b.critical))
})

const svgHeight = computed(() => Math.max(ROW_H, rows.value.length * ROW_H))

function relationRole(id: string): 'self' | 'pred' | 'succ' | null {
  const active = hoverId.value
  if (!active) return null
  if (id === active) return 'self'
  const cur = rowIndexByNodeId.value.get(active)?.node
  if (cur?.preds.some((p) => p.id === id)) return 'pred'
  const target = rowIndexByNodeId.value.get(id)?.node
  if (target?.preds.some((p) => p.id === active)) return 'succ'
  return null
}

function tip(n: GNode) {
  const parts = [`#${n.code} ${n.name}（${n.deptText}）`, `计划 ${n.startDate ? `${n.startDate} ~ ` : ''}${n.planDate}`]
  if (n.baselineDate && n.baselineDate !== n.planDate) parts.push(`基线 ${n.baselineDate}`)
  if (n.done) parts.push(`已完成 ${n.actualDate}`)
  else {
    parts.push(`预计 ${n.expectedDate}${n.delayDays > 0 ? `（晚 ${n.delayDays} 天）` : ''}`)
    if (n.slackDays != null) parts.push(n.slackDays <= 0 ? '关键节点：再晚就拖交期' : `余量 ${n.slackDays} 天`)
  }
  if (n.preds.length) parts.push(`前置 ${n.preds.map((p) => `#${p.code}${p.name ? ` ${p.name}` : ''}`).join('、')}`)
  return parts.join('\n')
}
const todayLeft = computed(() => pct(pos(props.today)))
const deliveryLeft = computed(() => (props.deliveryDate ? pct(pos(props.deliveryDate, true)) : null))
</script>

<template>
  <div class="gantt-wrap">
    <!-- Brick 风格浅灰圆角大托盘 + 纯白内嵌卡 -->
    <div class="project-tray">
      <div class="tray-head">
        <div class="tray-left">
          <span class="tray-chevron" aria-hidden="true">⌄</span>
          <span v-if="wo" class="tray-wo">{{ wo }}</span>
          <template v-if="projectName">
            <span class="tray-sep" aria-hidden="true">/</span>
            <span class="tray-product">{{ projectName }}</span>
          </template>
          <span class="tray-scope">总计划同屏甘特</span>
        </div>
        <div class="tray-right">
          <span v-if="deliveryDate">合同交期 <b class="tray-strong">{{ deliveryDate.slice(5) }}</b></span>
          <span class="mini-progress">
            <span class="mini-track"><span class="mini-fill" :style="{ width: `${overallPct}%` }" /></span>
            <span>{{ doneLeafCount }}/{{ totalLeafCount }} 已完成</span>
          </span>
        </div>
      </div>

      <div class="gantt-scroll">
        <div class="gantt" role="table" aria-label="总计划甘特图" @mouseleave="hoverId = null">
          <!-- 顶部刻度栏（左 4 列精简表头 + 右时间轴刻度） -->
          <div class="g-row g-head" role="row">
            <div class="g-split-cols g-head-cols" role="columnheader">
              <span>节点 / 任务名称</span>
              <span>责任部门 / 人</span>
              <span class="col-prog">进度</span>
              <span class="col-date">计划起止</span>
            </div>
            <div class="g-track g-head-track" role="columnheader">
              <span v-for="k in ticks" :key="k.left" class="tick-label" :class="{ minor: !k.major }" :style="{ left: k.left }">{{ k.label }}</span>
              <span class="marker-pill today-pill" :style="{ left: todayLeft }">今天</span>
              <span v-if="deliveryLeft" class="marker-pill delivery-pill" :style="{ left: deliveryLeft }">合同交期</span>
            </div>
          </div>

          <!-- 主体行与轨道 -->
          <div class="g-body">
            <!-- 背景网格竖线与今天/交期参考线 -->
            <div class="g-lines" aria-hidden="true">
              <span v-for="k in ticks" :key="k.left" class="tick" :class="{ minor: !k.major }" :style="{ left: k.left }" />
              <span class="today-line" :style="{ left: todayLeft }" />
              <span v-if="deliveryLeft" class="delivery-line" :style="{ left: deliveryLeft }" />
            </div>

            <!-- SVG 前置依赖连线层 -->
            <svg
              class="g-deps"
              :viewBox="`0 0 ${SVG_W} ${svgHeight}`"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <g v-for="e in depEdges" :key="e.key" class="dep-group" :class="{ active: e.active, critical: e.critical, compact: e.compact, dimmed: e.dimmed }">
                <path :d="e.path" class="dep-line" vector-effect="non-scaling-stroke" />
                <circle :cx="e.arrowX" :cy="e.arrowY" r="2.2" class="dep-dot" vector-effect="non-scaling-stroke" />
              </g>
            </svg>

            <!-- 阶段汇总行与节点行 -->
            <template v-for="r in rows" :key="r.key">
              <div v-if="r.kind === 'phase'" class="g-row g-phase" role="row">
                <div class="g-split-cols phase-cols" role="cell">
                  <div class="st-task">
                    <span class="phase-code">{{ r.code }}</span>
                    <span class="phase-name">{{ r.phase }}</span>
                  </div>
                  <span class="phase-meta">阶段汇总</span>
                  <span class="col-prog" :class="{ 'c-done': r.count && r.done === r.count }">
                    {{ r.count ? `${Math.round((r.done / r.count) * 100)}%` : '—' }}
                  </span>
                  <span class="col-date">{{ shortRange(r.start, r.end) }}</span>
                </div>
                <div class="g-track" role="cell">
                  <span class="phase-bar" :style="{ left: pct(pos(r.start)), width: pct(Math.max(0.8, pos(r.end, true) - pos(r.start))) }" :title="`${r.phase}：${r.start} ~ ${r.end}`" />
                </div>
              </div>

              <div
                v-else
                class="g-row g-node-row"
                :class="{
                  'child-row': r.n.parentId,
                  'last-child-row': r.isLastChild,
                  'summary-row': r.isSummary,
                  'is-hovered': relationRole(r.n.id) === 'self',
                  'is-related': relationRole(r.n.id) === 'pred' || relationRole(r.n.id) === 'succ',
                  'is-dimmed': relatedIds && !relatedIds.has(r.n.id),
                }"
                role="row"
                :aria-label="tip(r.n)"
                @mouseenter="hoverId = r.n.id"
              >
                <button type="button" class="g-split-cols node-cols" role="cell" :title="tip(r.n)" @click="emit('select', r.n.id)">
                  <span class="st-task">
                    <span class="seq" :class="{ child: r.n.parentId }">{{ r.n.code }}</span>
                    <span class="name" :class="{ 'summary-name': r.isSummary }">{{ r.n.name }}</span>
                    <UiAlertMark :level="nodeAlertLevel(r.n)" />
                    <span v-if="relationRole(r.n.id) === 'pred'" class="rel-tag pred">前置</span>
                    <span v-else-if="relationRole(r.n.id) === 'succ'" class="rel-tag succ">后继</span>
                  </span>
                  <span class="st-user">
                    <UiUserChip :name="r.n.confirmedByName || r.n.deptText" />
                  </span>
                  <span class="col-prog" :class="{ 'c-done': nodeProgress(r.n) === 100 }">
                    {{ nodeProgress(r.n) }}%
                  </span>
                  <span class="col-date" :class="{ 'c-danger': !r.n.done && r.n.delayDays > 0, 'c-warn': !r.n.done && r.n.dateConflict }">
                    {{ shortRange(r.n.startDate, r.n.planDate) }}
                  </span>
                </button>

                <div class="g-track" role="cell" :title="tip(r.n)" @click="emit('select', r.n.id)">
                  <span v-if="r.n.baselineDate && r.n.baselineDate !== r.n.planDate" class="baseline" :style="baseStyle(r.n)" />
                  <span
                    v-if="r.isSummary"
                    class="summary-bar"
                    :class="{ done: r.n.done }"
                    :style="barStyle(r.n)"
                  />
                  <span
                    v-else-if="isMilestone(r.n)"
                    class="milestone"
                    :class="{ done: r.n.done, critical: r.n.critical }"
                    :style="{ left: pct(pos(r.n.planDate) + (pos(r.n.planDate, true) - pos(r.n.planDate)) / 2) }"
                  />
                  <span
                    v-else
                    class="bar"
                    :class="{ done: r.n.done, critical: r.n.critical && !r.n.done }"
                    :style="barStyle(r.n)"
                  >
                    <span
                      v-if="!r.n.done && nodeProgress(r.n) > 0"
                      class="bar-progress-fill"
                      :style="{ width: `${nodeProgress(r.n)}%` }"
                    />
                  </span>
                  <span v-if="!r.n.done && r.n.delayDays > 0 && !r.isSummary" class="late" :style="lateStyle(r.n)" />
                  <span
                    v-if="predBadgeText(r.n)"
                    class="pred-badge"
                    :class="{ active: relationRole(r.n.id) === 'self' || relationRole(r.n.id) === 'succ' }"
                    :style="{ left: barEndLeft(r.n) }"
                  >
                    {{ predBadgeText(r.n) }}
                  </span>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部图例 -->
    <div class="legend">
      <span><i class="lg bar" />计划横道（内深色为完成比）</span>
      <span><i class="lg bar critical" />关键节点（零余量）</span>
      <span><i class="lg summary" />阶段 / 汇总</span>
      <span><i class="lg bar done" />已完成</span>
      <span><i class="lg late" />预计延误</span>
      <span><i class="lg milestone" />里程碑</span>
      <span><i class="lg dep" />前置关联（悬停高亮上下游）</span>
      <span><i class="lg today" />今天</span>
      <span><i class="lg delivery" />合同交期</span>
    </div>
  </div>
</template>

<style scoped>
.gantt-wrap { display: flex; flex-direction: column; gap: 10px; }

/* Brick 风格外层浅灰圆角托盘 */
.project-tray {
  background: var(--ft-tray-bg);
  border: 1px solid var(--ft-tray-border);
  border-radius: 14px;
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tray-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding: 2px 6px;
  font-size: 12.5px;
  color: var(--ft-text-2);
}
.tray-left, .tray-right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.tray-chevron {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--ft-card-bg);
  border: 1px solid var(--ft-border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--ft-text-2);
  font-size: 11px;
  line-height: 1;
}
.tray-wo { font-size: 14px; font-weight: 600; color: var(--ft-text); }
.tray-sep { color: var(--ft-border-hover); }
.tray-product { color: var(--ft-text-2); font-size: 13px; }
.tray-scope { color: var(--ft-text-3); font-size: 12px; margin-left: 4px; }
.tray-strong { color: var(--ft-text); font-weight: 600; }
.mini-progress { display: inline-flex; align-items: center; gap: 8px; margin-left: 6px; }
.mini-track { width: 48px; height: 6px; border-radius: 999px; background: var(--ft-border-hover); overflow: hidden; }
.mini-fill { display: block; height: 100%; background: var(--ft-done); border-radius: 999px; }

/* 内层纯白圆角表格+甘特一体卡 */
.gantt-scroll {
  overflow-x: auto;
  border: 1px solid var(--ft-border);
  border-radius: 10px;
  background: var(--ft-card-bg);
}
.gantt { min-width: 1060px; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.g-row { display: grid; grid-template-columns: 490px 1fr; height: 38px; align-items: center; border-bottom: 1px solid var(--card-border-subtle); transition: background-color 0.12s, opacity 0.15s; }
.g-body > .g-row:last-child { border-bottom: none; }

/* 表头 */
.g-head { height: 42px; background: var(--ft-card-bg); color: var(--ft-text-3); font-size: 11.5px; font-weight: 600; border-bottom: 1px solid var(--ft-border); }
.g-head-track { overflow: hidden; }

/* 左半边 4 列精简表（节点名称 | 责任人 | 进度 | 计划起止） */
.g-split-cols {
  position: relative;
  padding: 0 14px;
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) 108px 54px 86px;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 100%;
  border-right: 1px solid var(--ft-border);
  overflow: hidden;
}
.node-cols {
  background: none;
  border: 0;
  border-right: 1px solid var(--ft-border);
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: var(--ft-text);
  height: 100%;
  width: 100%;
}
.node-cols:hover .name { color: var(--ft-primary); }
.node-cols:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: -2px; }

.st-task { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; }
.st-user { min-width: 0; overflow: hidden; }
.col-prog { text-align: right; padding-right: 6px; color: var(--ft-text-2); font-size: 12px; font-weight: 500; }
.col-date { color: var(--ft-text-2); font-size: 12px; white-space: nowrap; }
.c-done { color: var(--ft-done-text); font-weight: 600; }
.c-warn { color: var(--ft-risk-text); font-weight: 500; }
.c-danger { color: var(--ft-late-text); font-weight: 500; }

.seq { flex: none; min-width: 26px; color: var(--ft-text-3); font-size: 12px; }
.seq.child { margin-left: 18px; min-width: 32px; }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.summary-name { font-weight: 600; }

/* 子节点左侧连续树形引导线 */
.child-row .node-cols::before { content: ""; position: absolute; left: 22px; top: 0; bottom: 0; border-left: 1px solid var(--ft-border-hover); pointer-events: none; }
.child-row.last-child-row .node-cols::before { bottom: 50%; }
.child-row .node-cols::after { content: ""; position: absolute; left: 22px; top: 50%; width: 8px; border-top: 1px solid var(--ft-border-hover); pointer-events: none; }

/* 悬停上下游联动高亮 */
.g-node-row:hover, .g-node-row.is-hovered { background: var(--ft-primary-bg); }
.g-node-row.is-related { background: var(--ft-fill); }
.g-node-row.is-dimmed { opacity: 0.42; }
.rel-tag { flex: none; padding: 0 5px; height: 17px; line-height: 17px; border-radius: 999px; font-size: 10.5px; font-weight: 500; }
.rel-tag.pred { background: var(--ft-indigo-bg); color: var(--ft-indigo-text); }
.rel-tag.succ { background: var(--ft-primary-bg); color: var(--ft-primary-text); }

/* 右侧时间轴轨道与网格线 */
.g-track { position: relative; height: 100%; cursor: pointer; }
.g-phase .g-track, .g-head .g-track { cursor: default; }
.g-body { position: relative; }
.g-lines { position: absolute; inset: 0 0 0 490px; pointer-events: none; z-index: 0; }
.tick { position: absolute; top: 0; bottom: 0; border-left: 1px solid var(--ft-border); }
.tick.minor { border-left: 1px dashed var(--card-border-subtle); }
.tick-label { position: absolute; top: 11px; transform: translateX(5px); white-space: nowrap; color: var(--ft-text-2); font-weight: 500; }
.tick-label.minor { color: var(--ft-text-3); font-weight: 400; font-size: 11px; }

/* 今天 & 合同交期竖线与顶部胶囊 */
.today-line { position: absolute; top: 0; bottom: 0; border-left: 1.5px solid var(--ft-primary); z-index: 3; }
.delivery-line { position: absolute; top: 0; bottom: 0; border-left: 2px solid var(--ft-text); z-index: 3; }
.marker-pill { position: absolute; bottom: 4px; transform: translateX(-50%); padding: 0 6px; height: 16px; line-height: 16px; border-radius: 999px; font-size: 10px; font-weight: 600; white-space: nowrap; z-index: 4; pointer-events: none; }
.today-pill { background: var(--ft-primary-bg); color: var(--ft-primary-text); border: 1px solid var(--ft-primary); }
.delivery-pill { background: var(--ft-text); color: var(--ft-card-bg); }

/* SVG 依赖连线 */
.g-deps { position: absolute; inset: 0 0 0 490px; width: calc(100% - 490px); height: 100%; pointer-events: none; z-index: 1; overflow: visible; }
.dep-line { fill: none; stroke: var(--ft-border-hover); stroke-width: 1.2px; stroke-dasharray: 3 3; opacity: 0.45; transition: stroke 0.15s, stroke-width 0.15s, opacity 0.15s; }
.dep-dot { fill: var(--ft-border-hover); opacity: 0.5; transition: fill 0.15s, opacity 0.15s; }
.dep-group.compact .dep-line { stroke-dasharray: none; opacity: 0.75; }
.dep-group.critical .dep-line { stroke: var(--ft-primary); stroke-dasharray: none; opacity: 0.65; }
.dep-group.critical .dep-dot { fill: var(--ft-primary); opacity: 0.8; }
.dep-group.dimmed .dep-line, .dep-group.dimmed .dep-dot { opacity: 0.12; }
.dep-group.active .dep-line { stroke: var(--ft-primary); stroke-width: 1.8px; stroke-dasharray: none; opacity: 1; }
.dep-group.active .dep-dot { fill: var(--ft-primary); opacity: 1; }

/* 阶段行与阶段括号横梁 */
.g-phase { background: var(--ft-fill); font-weight: 600; }
.phase-code { color: var(--ft-text-2); min-width: 16px; }
.phase-name { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.phase-meta { color: var(--ft-text-3); font-size: 11.5px; font-weight: 400; }
.phase-bar { position: absolute; top: 50%; height: 6px; margin-top: -4px; background: var(--ft-text-2); border-radius: 2px 2px 0 0; z-index: 2; }
.phase-bar::before, .phase-bar::after { content: ""; position: absolute; bottom: -4px; width: 0; height: 0; border-top: 4px solid var(--ft-text-2); }
.phase-bar::before { left: 0; border-right: 4px solid transparent; }
.phase-bar::after { right: 0; border-left: 4px solid transparent; }

/* 二级汇总节点横梁 */
.summary-bar { position: absolute; top: 50%; height: 6px; margin-top: -3px; background: var(--ft-text-3); border-radius: 2px; z-index: 2; }
.summary-bar::before, .summary-bar::after { content: ""; position: absolute; bottom: -3px; width: 0; height: 0; border-top: 3px solid var(--ft-text-3); }
.summary-bar::before { left: 0; border-right: 3px solid transparent; }
.summary-bar::after { right: 0; border-left: 3px solid transparent; }
.summary-bar.done { background: var(--ft-done); }
.summary-bar.done::before, .summary-bar.done::after { border-top-color: var(--ft-done); }

/* 作业节点横道（双色进度填充）、里程碑、延误段与前置标签 */
.bar {
  position: absolute;
  top: 50%;
  height: 16px;
  margin-top: -8px;
  border-radius: 5px;
  background: var(--ft-indigo-bg);
  border: 1px solid var(--ft-indigo);
  z-index: 2;
  box-sizing: border-box;
  overflow: hidden;
  transition: transform 0.12s, box-shadow 0.12s;
}
.bar-progress-fill {
  display: block;
  height: 100%;
  background: var(--ft-indigo);
  border-radius: 4px;
}
.g-node-row.is-hovered .bar { box-shadow: 0 0 0 2px var(--ft-primary-bg), 0 1px 4px rgba(9, 9, 11, 0.12); }
.bar.critical { background: var(--ft-primary-bg); border-color: var(--ft-primary); }
.bar.critical .bar-progress-fill { background: var(--ft-primary); }
.bar.done { background: var(--ft-done); border-color: var(--ft-done); }
.late { position: absolute; top: 50%; height: 16px; margin-top: -8px; border-radius: 0 5px 5px 0; z-index: 2; box-sizing: border-box;
  background: repeating-linear-gradient(135deg, var(--ft-late) 0 3px, var(--ft-late-bg) 3px 6px); border: 1px solid var(--ft-late); border-left: 0; }
.milestone { position: absolute; top: 50%; width: 10px; height: 10px; margin: -5px 0 0 -5px; transform: rotate(45deg); background: var(--ft-card-bg); border: 2px solid var(--ft-primary); border-radius: 1px; z-index: 3; box-sizing: border-box; }
.milestone.critical { background: var(--ft-primary); }
.milestone.done { background: var(--ft-done); border-color: var(--ft-done); }
.baseline { position: absolute; top: 50%; height: 3px; margin-top: 9px; background: var(--ft-text-3); border-radius: 1px; z-index: 1; }

.pred-badge { position: absolute; top: 50%; transform: translate(6px, -50%); font-size: 11px; color: var(--ft-text-3); white-space: nowrap; pointer-events: none; z-index: 3; padding: 0 4px; border-radius: 4px; transition: color 0.12s, background-color 0.12s; }
.pred-badge.active { color: var(--ft-primary-text); background: var(--ft-primary-bg); font-weight: 500; }

/* 图例 */
.legend { display: flex; flex-wrap: wrap; gap: 8px 18px; padding: 2px 4px; font-size: 12px; color: var(--ft-text-2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.lg { display: inline-block; width: 18px; height: 10px; border-radius: 3px; position: relative; box-sizing: border-box; }
.lg.bar { position: relative; top: 0; margin: 0; height: 10px; }
.lg.summary { height: 5px; background: var(--ft-text-2); border-radius: 1px; }
.lg.late { background: repeating-linear-gradient(135deg, var(--ft-late) 0 3px, var(--ft-late-bg) 3px 6px); border: 1px solid var(--ft-late); }
.lg.milestone { width: 9px; height: 9px; margin: 0 3px; transform: rotate(45deg); position: relative; top: 0; border-width: 2px; border-radius: 1px; }
.lg.dep { height: 0; border-top: 1.5px solid var(--ft-primary); border-radius: 0; }
.lg.dep::after { content: ""; position: absolute; right: -1px; top: -3px; width: 4px; height: 4px; border-radius: 50%; background: var(--ft-primary); }
.lg.today { width: 0; height: 12px; border-left: 1.5px solid var(--ft-primary); border-radius: 0; }
.lg.delivery { width: 0; height: 12px; border-left: 2px solid var(--ft-text); border-radius: 0; }
</style>
