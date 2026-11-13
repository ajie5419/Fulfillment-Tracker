<script setup lang="ts">
/**
 * 计划甘特图 (PlanGantt) - 1:1 还原 BRICK 现代工程协同视觉规范
 * 1. 外层浅灰圆角大托盘 (Project Tray, #F9F9F9, sRGB 0.977)
 * 2. 托盘顶栏信息提纯 (单行流式排开工单、项目名称、交付日期、完成度、快捷操作)
 * 3. 纯白内嵌精密卡片 (#FFFFFF)
 * 4. 左半边 4 列极简大纲表 (TASK | ASSIGNED | PROGRESS | DATES) - Sticky 固定吸顶吸左
 * 5. 右半边双色调日历甘特图 (月份条 + 34px 舒适日宽 + 今日蓝色胶囊药丸 + 贯穿细蓝线 + 周末柔灰背景带 + 药丸胶囊横道)
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import type { AlertLevel } from '~/components/ui/AlertMark.vue'

export interface GNode {
  id: string
  parentId: string | null
  code: string
  name: string
  phase?: string | null
  deptText?: string | null
  confirmedByName?: string | null
  planDate: string
  startDate?: string | null
  expectedDate: string
  actualDate?: string | null
  baselineDate?: string | null
  done: boolean
  critical: boolean
  delayDays: number
  childCount?: number
  taskCount?: number
  doneCount?: number
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
const DAY_WIDTH = 34
const GANTT_LAYOUT = {
  leftWidth: 480,
  rowHeight: 38,
  headHeight: 52,
  svgWidth: 1000,
  shortSpanDays: 45,
  midMonthDay: 15,
  compactRowSpan: 4,
  maxInlinePreds: 2,
} as const

const ganttCssVars = {
  '--gantt-left-w': `${GANTT_LAYOUT.leftWidth}px`,
  '--gantt-row-h': `${GANTT_LAYOUT.rowHeight}px`,
  '--gantt-head-h': `${GANTT_LAYOUT.headHeight}px`,
}

const hoverId = ref<string | null>(null)
const scrollContainer = ref<HTMLElement | null>(null)

const t = (d: string) => Date.parse(`${d}T00:00:00.000Z`)

// 确定全局日历范围（对齐到整天）
const range = computed(() => {
  const days: number[] = [t(props.today)]
  for (const n of props.nodes) {
    days.push(t(n.startDate ?? n.planDate), t(n.planDate), t(n.expectedDate))
    if (n.actualDate) days.push(t(n.actualDate))
    if (n.baselineDate) days.push(t(n.baselineDate))
  }
  if (props.deliveryDate) days.push(t(props.deliveryDate))
  const rawMin = Math.min(...days) - 2 * DAY
  const rawMax = Math.max(...days) + 4 * DAY
  const startDate = new Date(rawMin)
  const min = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
  const endDate = new Date(rawMax)
  const max = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate())
  const span = Math.max(DAY, max - min + DAY)
  return { min, span }
})

const WEEKDAY_NAMES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

interface CalendarDay {
  dateStr: string
  dayName: string
  dateNum: number
  isWeekend: boolean
  isToday: boolean
}

const calendarDays = computed<CalendarDay[]>(() => {
  const { min, span } = range.value
  const list: CalendarDay[] = []
  for (let d = min; d < min + span; d += DAY) {
    const x = new Date(d)
    const y = x.getUTCFullYear()
    const m = x.getUTCMonth() + 1
    const dt = x.getUTCDate()
    const dow = x.getUTCDay()
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(dt).padStart(2, '0')}`
    list.push({
      dateStr,
      dayName: WEEKDAY_NAMES[dow] ?? 'MO',
      dateNum: dt,
      isWeekend: dow === 0 || dow === 6,
      isToday: dateStr === props.today,
    })
  }
  return list
})

interface MonthGroup {
  key: string
  label: string
  daysCount: number
  widthPx: number
}

const monthGroups = computed<MonthGroup[]>(() => {
  const groups: MonthGroup[] = []
  let currentKey = ''
  let currentGroup: MonthGroup | null = null

  for (const d of calendarDays.value) {
    const ym = d.dateStr.slice(0, 7)
    if (ym !== currentKey) {
      currentKey = ym
      const parts = ym.split('-')
      const y = parts[0] ?? ''
      const m = Number(parts[1] ?? '1')
      currentGroup = {
        key: ym,
        label: `${y}年 ${m}月`,
        daysCount: 0,
        widthPx: 0,
      }
      groups.push(currentGroup)
    }
    if (currentGroup) {
      currentGroup.daysCount++
      currentGroup.widthPx = currentGroup.daysCount * DAY_WIDTH
    }
  }
  return groups
})

const timelineWidthPx = computed(() => Math.max(600, calendarDays.value.length * DAY_WIDTH))

/** 某天的左边位置（0~100%）；end = true 取当天结束 */
const pos = (d: string, end = false) => ((t(d) + (end ? DAY : 0) - range.value.min) / range.value.span) * 100
const clampPct = (v: number) => Math.max(0, Math.min(100, v))
const pct = (v: number) => `${clampPct(v).toFixed(3)}%`

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
    const isLastChild = Boolean(n.parentId && (!next || next.parentId !== n.parentId))
    out.push({ kind: 'node', key: n.id, n, isSummary: (n.childCount ?? 0) > 0, isLastChild })
  }
  return out
})

const isMilestone = (n: GNode) => !(n.childCount && n.childCount > 0) && (!n.startDate || n.startDate === n.planDate)

function nodeProgress(n: { done?: boolean; childCount?: number; taskCount?: number; doneCount?: number; id?: string }): number {
  if (n.done) return 100
  /** Direct tasks and child nodes are separate completion obligations; task counts exclude children. */
  const children = props.nodes.filter((child) => child.parentId === n.id)
  const total = (n.taskCount ?? 0) + Math.max(n.childCount ?? 0, children.length)
  const completed = (n.doneCount ?? 0) + children.filter((child) => child.done).length
  return total ? Math.round((completed / total) * 100) : 0
}

const shortDayText = (d: string) => {
  const parts = d.split('-')
  return `${parts[1] ?? ''}-${parts[2] ?? ''}`
}

const shortRangeText = (start?: string | null, end?: string | null) => {
  if (!start && !end) return '—'
  if (!start || start === end) return shortDayText(end ?? '')
  return `${shortDayText(start)} ~ ${shortDayText(end ?? '')}`
}

const nodeAlertLevel = (n: GNode): AlertLevel => {
  if (n.done) return 'none'
  if (n.delayDays > 0) return 'danger'
  if (n.dateConflict) return 'warn'
  return 'none'
}

const baseStyle = (n: GNode) => {
  if (!n.baselineDate) return {}
  const left = pct(pos(n.startDate ?? n.baselineDate))
  const width = pct(Math.max(0.6, pos(n.baselineDate, true) - pos(n.startDate ?? n.baselineDate)))
  return { left, width }
}

const barStyle = (n: GNode) => {
  const start = n.startDate ?? n.planDate
  const left = pct(pos(start))
  const width = pct(Math.max(0.8, pos(n.planDate, true) - pos(start)))
  return { left, width }
}

const barEndLeft = (n: GNode) => pct(pos(n.planDate, true))

const lateStyle = (n: GNode) => {
  const left = pct(pos(n.planDate, true))
  const width = pct(Math.max(0.6, pos(n.expectedDate, true) - pos(n.planDate, true)))
  return { left, width }
}

const predBadgeText = (n: GNode) => {
  if (!n.preds || !n.preds.length) return ''
  const codes = n.preds.map((p) => p.code).slice(0, GANTT_LAYOUT.maxInlinePreds)
  return `← ${codes.join(', ')}`
}

const tip = (n: GNode) => {
  const rangeStr = shortRangeText(n.startDate, n.planDate)
  const owner = n.confirmedByName ? `${n.confirmedByName}（${n.deptText}）` : n.deptText
  const lines = [`${n.code} ${n.name}`, `责任：${owner ?? '—'}`, `计划：${rangeStr}`]
  if (n.delayDays > 0) lines.push(`延误：${n.delayDays} 天`)
  return lines.join('\n')
}

// 依赖连线与高亮
const nodeRowIndexMap = computed(() => {
  const map = new Map<string, number>()
  rows.value.forEach((r, idx) => {
    if (r.kind === 'node') map.set(r.n.id, idx)
  })
  return map
})

const predGraph = computed(() => {
  const predsOf = new Map<string, string[]>()
  const succsOf = new Map<string, string[]>()
  for (const n of props.nodes) {
    const pids = (n.preds ?? []).map((p) => p.id)
    predsOf.set(n.id, pids)
    for (const pid of pids) {
      const arr = succsOf.get(pid) ?? []
      arr.push(n.id)
      succsOf.set(pid, arr)
    }
  }
  return { predsOf, succsOf }
})

const relatedIds = computed<Set<string> | null>(() => {
  const id = hoverId.value
  if (!id) return null
  const set = new Set<string>([id])
  const walk = (cur: string, map: Map<string, string[]>) => {
    for (const next of map.get(cur) ?? []) {
      if (!set.has(next)) {
        set.add(next)
        walk(next, map)
      }
    }
  }
  walk(id, predGraph.value.predsOf)
  walk(id, predGraph.value.succsOf)
  return set
})

const relationRole = (id: string): 'self' | 'pred' | 'succ' | 'none' => {
  const cur = hoverId.value
  if (!cur) return 'none'
  if (id === cur) return 'self'
  if (predGraph.value.predsOf.get(cur)?.includes(id)) return 'pred'
  if (predGraph.value.succsOf.get(cur)?.includes(id)) return 'succ'
  return 'none'
}

interface DepEdge {
  key: string
  path: string
  arrowX: number
  arrowY: number
  active: boolean
  critical: boolean
  compact: boolean
  dimmed: boolean
}

const svgHeight = computed(() => rows.value.length * GANTT_LAYOUT.rowHeight)

const depEdges = computed<DepEdge[]>(() => {
  const edges: DepEdge[] = []
  const nodeMap = new Map(props.nodes.map((n) => [n.id, n]))
  const hId = hoverId.value
  const relSet = relatedIds.value

  for (const n of props.nodes) {
    const toRow = nodeRowIndexMap.value.get(n.id)
    if (toRow == null) continue
    for (const p of n.preds ?? []) {
      const fromNode = nodeMap.get(p.id)
      const fromRow = nodeRowIndexMap.value.get(p.id)
      if (!fromNode || fromRow == null) continue

      const x1 = (pos(fromNode.planDate, true) / 100) * GANTT_LAYOUT.svgWidth
      const y1 = fromRow * GANTT_LAYOUT.rowHeight + GANTT_LAYOUT.rowHeight / 2
      const x2 = (pos(n.startDate ?? n.planDate) / 100) * GANTT_LAYOUT.svgWidth
      const y2 = toRow * GANTT_LAYOUT.rowHeight + GANTT_LAYOUT.rowHeight / 2

      const rowSpan = Math.abs(toRow - fromRow)
      const isShort = rowSpan <= GANTT_LAYOUT.compactRowSpan
      const active = Boolean(hId && (n.id === hId || fromNode.id === hId))
      const dimmed = Boolean(relSet && !relSet.has(n.id) && !relSet.has(fromNode.id))
      const critical = n.critical && fromNode.critical

      const offset = isShort ? 6 : 10
      const midX = Math.max(x1 + offset, Math.min(x2 - offset, (x1 + x2) / 2))
      const path = `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`

      edges.push({
        key: `${fromNode.id}->${n.id}`,
        path,
        arrowX: x2,
        arrowY: y2,
        active,
        critical,
        compact: isShort,
        dimmed,
      })
    }
  }
  return edges
})

const deliveryLeft = computed(() => (props.deliveryDate ? pct(pos(props.deliveryDate)) : null))

// 页面挂载后自动平滑定位到「今天」
onMounted(() => {
  nextTick(() => {
    if (!scrollContainer.value) return
    const todayIndex = calendarDays.value.findIndex((d) => d.isToday)
    if (todayIndex > 0) {
      const targetScroll = Math.max(0, todayIndex * DAY_WIDTH - 160)
      scrollContainer.value.scrollLeft = targetScroll
    }
  })
})
</script>

<template>
  <div class="gantt-wrap" @mouseleave="hoverId = null">
    <!-- 浅灰大圆角托盘 (Project Tray) -->
    <section class="project-tray">
      <!-- 托盘顶栏 -->
      <div class="tray-head">
        <div class="tray-left">
          <button type="button" class="tray-chevron" aria-label="收起/展开工单">⌄</button>
          <span class="av-circle">{{ (wo || '工')[0] }}</span>
          <span class="tray-wo">{{ wo || 'DEMO-001' }}</span>
          <span class="tray-sep">/</span>
          <span class="tray-product">{{ projectName || '全生命周期协同工程' }}</span>
          <span class="tray-scope">阶段：全生命周期 ⌄</span>
        </div>
        <div class="tray-right">
          <span v-if="deliveryDate">合同交期 <b class="tray-strong">{{ shortDayText(deliveryDate) }}</b></span>
          <span class="tray-sep">·</span>
          <span class="mini-progress">
            <span class="mini-track"><span class="mini-fill" :style="{ width: `${overallPct}%` }" /></span>
            <span>{{ doneLeafCount }}/{{ totalLeafCount }} 已完成</span>
          </span>
          <span class="tray-icons" aria-hidden="true">
            <span>📷</span>
            <span>📎</span>
            <span>✏</span>
            <span>⛶</span>
          </span>
        </div>
      </div>

      <!-- 纯白内嵌精密卡片 (Inset Card) -->
      <div class="inset-card">
        <div ref="scrollContainer" class="gantt-scroll">
          <div class="gantt" :style="{ ...ganttCssVars, '--gantt-timeline-w': `${timelineWidthPx}px` }">
            <!-- 表头 -->
            <div class="g-row g-head">
              <div class="g-split-cols">
                <span class="col-head">TASK</span>
                <span class="col-head">ASSIGNED</span>
                <span class="col-head" style="text-align: right">PROGRESS</span>
                <span class="col-head">DATES</span>
              </div>
              <div class="gt-timeline-track">
                <div class="gt-head">
                  <!-- 月份标头栏 -->
                  <div class="gt-months-row">
                    <div
                      v-for="m in monthGroups"
                      :key="m.key"
                      class="gt-month-cell"
                      :style="{ width: `${m.widthPx}px` }"
                    >
                      <span class="month-title">{{ m.label }}</span>
                    </div>
                  </div>
                  <!-- 日期与星期标头栏 -->
                  <div class="gt-days-row" :style="{ gridTemplateColumns: `repeat(${calendarDays.length}, ${DAY_WIDTH}px)` }">
                    <div
                      v-for="d in calendarDays"
                      :key="d.dateStr"
                      class="gt-day"
                      :class="{ weekend: d.isWeekend, today: d.isToday }"
                    >
                      <span class="d-name">{{ d.dayName }}</span>
                      <span class="d-num">{{ d.dateNum }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 主体行与轨道 -->
            <div class="g-body">
              <!-- 垂直网格线背景层（含周末浅灰底色带 + 今日贯穿细蓝线） -->
              <div class="gt-cols-bg" :style="{ gridTemplateColumns: `repeat(${calendarDays.length}, ${DAY_WIDTH}px)` }" aria-hidden="true">
                <div
                  v-for="d in calendarDays"
                  :key="d.dateStr"
                  class="gt-col-cell"
                  :class="{ weekend: d.isWeekend, 'today-line': d.isToday }"
                />
              </div>

              <!-- 合同交期垂直指示线 -->
              <div
                v-if="deliveryLeft != null"
                class="gt-delivery-line"
                :style="{ left: deliveryLeft }"
                title="合同交期"
              >
                <div class="gt-delivery-tag">合同交期 {{ shortDayText(props.deliveryDate ?? '') }}</div>
              </div>

              <!-- SVG 前置依赖连线层 -->
              <svg
                class="g-deps"
                :viewBox="`0 0 ${GANTT_LAYOUT.svgWidth} ${svgHeight}`"
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
                    <span class="col-date">{{ shortRangeText(r.start, r.end) }}</span>
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
                      {{ shortRangeText(r.n.startDate, r.n.planDate) }}
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
    </section>

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
@import '~/assets/plan-gantt.css';
</style>
