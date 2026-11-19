<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { PLAN_STATUS_TEXT, planDisplayState } from '#shared/plan'
import type { PlanData } from '../composables/usePlanData'
import type { GanttRange } from './BoardPlanBranch.vue'

const props = defineProps<{ wo: string; mobile?: boolean }>()
const { data, error, refresh } = useApiFetch<PlanData>('/api/plan', {
  key: 'board-plan:' + props.wo,
  query: { workOrderNumber: props.wo },
})
defineExpose({ refresh })

type Node = PlanData['nodes'][number]
const DAY_MS = 86_400_000
const toMs = (d?: string | null) => (d ? Date.parse(`${d}T00:00:00Z`) : Number.NaN)

const state = computed(() => planDisplayState(data.value?.plan?.status, data.value?.nodes.length ?? 0))
const published = computed(() => state.value === 'PUBLISHED')

const groups = computed(() => {
  const phases = new Map<string, Node[]>()
  const children = new Map<string, Node[]>()
  for (const node of data.value?.nodes ?? []) {
    const collection = node.parentId ? children : phases
    const key = node.parentId ?? node.phase ?? ''
    const siblings = collection.get(key) ?? []
    siblings.push(node)
    collection.set(key, siblings)
  }
  return { phases, children }
})

const sources = computed(() =>
  published.value
    ? (data.value?.nodes ?? [])
        .filter((n) => n.source && !n.dateConflict)
        .sort((a, b) => Number(b.critical) - Number(a.critical) || b.selfDelayDays - a.selfDelayDays || a.seq - b.seq)
    : [],
)

const path = computed(() => {
  const ids = new Set<string>()
  const nodes = new Map(data.value?.nodes.map((n) => [n.id, n]))
  let node = sources.value[0]
  let phase: string | undefined
  while (node && !ids.has(node.id)) {
    ids.add(node.id)
    phase = node.phase ?? ''
    node = node.parentId ? nodes.get(node.parentId) : undefined
  }
  return { ids, phase }
})

// ───── A：工期标尺 + 阶段里程碑统计 ─────
const allNodes = computed(() => data.value?.nodes ?? [])
const leafNodes = computed(() => {
  const parentIds = new Set(allNodes.value.map((n) => n.parentId).filter(Boolean))
  return allNodes.value.filter((n) => !parentIds.has(n.id))
})
const totalProgress = computed(() => {
  const total = leafNodes.value.length
  const done = leafNodes.value.filter((n) => n.done).length
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 }
})

const ganttRange = computed<GanttRange | null>(() => {
  const msList: number[] = []
  for (const n of allNodes.value) {
    for (const d of [n.startDate, n.planDate, n.expectedDate, n.actualDate]) {
      const m = toMs(d)
      if (Number.isFinite(m)) msList.push(m)
    }
  }
  const deliveryMs = toMs(data.value?.workOrder.deliveryDate)
  if (Number.isFinite(deliveryMs)) msList.push(deliveryMs)
  if (!msList.length) return null
  const todayStr = data.value?.today ?? new Date().toISOString().slice(0, 10)
  const todayMs = toMs(todayStr)
  const minMs = Math.min(...msList) - 2 * DAY_MS
  const maxMs = Math.max(...msList) + 4 * DAY_MS
  const spanMs = Math.max(DAY_MS, maxMs - minMs)
  const clamp = (m: number) => Math.max(0, Math.min(100, ((m - minMs) / spanMs) * 100))
  const ticks: number[] = []
  const start = new Date(minMs)
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  while (cur.getTime() <= maxMs) {
    const left = ((cur.getTime() - minMs) / spanMs) * 100
    if (left >= 0 && left <= 92) ticks.push(left)
    cur.setUTCMonth(cur.getUTCMonth() + 1)
  }
  return {
    minMs,
    spanMs,
    todayPct: Number.isFinite(todayMs) ? clamp(todayMs) : 0,
    duePct: Number.isFinite(deliveryMs) ? clamp(deliveryMs + DAY_MS) : null,
    ticks,
  }
})

const monthTicks = computed(() => {
  const g = ganttRange.value
  if (!g) return []
  const out: { label: string; left: number }[] = []
  const start = new Date(g.minMs)
  const endMs = g.minMs + g.spanMs
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  while (cur.getTime() <= endMs) {
    const left = ((cur.getTime() - g.minMs) / g.spanMs) * 100
    if (left >= 0 && left <= 92) {
      out.push({ label: `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`, left })
    }
    cur.setUTCMonth(cur.getUTCMonth() + 1)
  }
  return out
})

const rulerStats = computed(() => {
  const nodes = allNodes.value
  const starts = nodes.map((n) => n.startDate ?? n.planDate).filter(Boolean).sort()
  const startDay = starts[0] ?? '—'
  const dueDay = data.value?.workOrder.deliveryDate || '—'
  const todayStr = data.value?.today ?? new Date().toISOString().slice(0, 10)
  const sMs = toMs(starts[0])
  const dMs = toMs(data.value?.workOrder.deliveryDate)
  const tMs = toMs(todayStr)
  if (!Number.isFinite(sMs) || !Number.isFinite(dMs) || dMs <= sMs) return null
  const totalDays = Math.max(1, Math.round((dMs - sMs) / DAY_MS))
  const usedDays = Math.max(0, Math.round((tMs - sMs) / DAY_MS))
  const usedPct = Math.max(0, Math.min(100, Math.round((usedDays / totalDays) * 100)))
  return { startDay, dueDay, todayStr, totalDays, usedDays, usedPct }
})

const phaseSummaries = computed(() => {
  const byPhase = new Map<string, Node[]>()
  for (const n of allNodes.value) {
    const key = n.phase ?? ''
    const list = byPhase.get(key) ?? []
    list.push(n)
    byPhase.set(key, list)
  }
  return [...groups.value.phases.entries()].map(([phase, roots]) => {
    const pool = byPhase.get(phase) ?? roots
    const parentIds = new Set(pool.map((n) => n.parentId).filter(Boolean))
    const leaves = pool.filter((n) => !parentIds.has(n.id))
    const done = leaves.filter((n) => n.done).length
    const total = leaves.length
    const pct = total ? Math.round((done / total) * 100) : 0
    const hasSource = published.value && pool.some((n) => n.source)
    const hasUpstream = published.value && pool.some((n) => n.upstream)
    const tone = hasSource ? 'late' : hasUpstream ? 'risk' : total > 0 && done === total ? 'done' : 'primary'
    const g = ganttRange.value
    let bar: { planLeft: number; planWidth: number; realWidth: number } | null = null
    if (g) {
      const pStarts = pool.map((n) => toMs(n.startDate ?? n.planDate)).filter(Number.isFinite)
      const pEnds = pool.map((n) => toMs(n.planDate)).filter(Number.isFinite)
      const rEnds = pool.map((n) => toMs(n.actualDate ?? (published.value && !n.dateConflict ? n.expectedDate : n.planDate))).filter(Number.isFinite)
      if (pStarts.length && pEnds.length) {
        const minS = Math.min(...pStarts)
        const maxP = Math.max(...pEnds) + DAY_MS
        const maxR = rEnds.length ? Math.max(...rEnds) + DAY_MS : maxP
        const left = ((minS - g.minMs) / g.spanMs) * 100
        bar = {
          planLeft: Math.max(0, left),
          planWidth: Math.max(1.5, ((maxP - minS) / g.spanMs) * 100),
          realWidth: Math.max(1.5, ((maxR - minS) / g.spanMs) * 100),
        }
      }
    }
    return {
      phase,
      roots,
      done,
      total,
      pct,
      tone,
      hasSource,
      hasUpstream,
      bar,
      deptText: roots[0]?.deptText ?? '',
    }
  })
})

const selectedPhase = ref<string | null>(null)
watch(() => props.wo, () => { selectedPhase.value = null })
const visiblePhases = computed(() =>
  selectedPhase.value == null ? phaseSummaries.value : phaseSummaries.value.filter((p) => p.phase === selectedPhase.value),
)

// ───── C：部门接力完成度 + 阻塞传导链 ─────
const deptRelay = computed(() => {
  const map = new Map<string, { dept: string; done: number; total: number; late: number }>()
  for (const n of leafNodes.value) {
    const dept = n.deptText || '未分部门'
    const cur = map.get(dept) ?? { dept, done: 0, total: 0, late: 0 }
    cur.total += 1
    if (n.done) cur.done += 1
    if (published.value && (n.source || n.upstream)) cur.late += 1
    map.set(dept, cur)
  }
  return [...map.values()].map((d) => ({
    ...d,
    pct: d.total ? Math.round((d.done / d.total) * 100) : 0,
    tone: d.late > 0 ? 'risk' : d.done === d.total && d.total > 0 ? 'done' : 'primary',
  }))
})

const blockedChain = computed(() => {
  if (!published.value || !sources.value.length) return []
  const src = sources.value[0]
  const downstream = allNodes.value.filter((n) => n.upstream && n.pushedBy?.code === src.code).slice(0, 2)
  return [src, ...downstream]
})
</script>

<template>
  <p v-if="error" role="alert">工单计划加载失败 · {{ apiError(error) }} <button @click="refresh()">重试</button></p>
  <p v-else-if="!data">正在读取总计划…</p>
  <div v-else class="progress-board">
    <!-- A1：工单摘要 + 工期时间标尺 -->
    <section class="root">
      <div class="heading">
        <div class="title-group">
          <h2>{{ data.workOrder.projectName || wo }}</h2>
          <NuxtLink :to="mobile ? { path: '/m/plan', query: { wo } } : '/wo/' + encodeURIComponent(wo)" class="wo-link">{{ wo }}</NuxtLink>
          <strong v-if="published && data.dateConflicts.length" class="state-pill risk">交期待核实</strong>
          <strong v-else-if="(data.deliveryDelayDays ?? 0) > 0 && published" class="state-pill late">预计晚 {{ data.deliveryDelayDays }} 天</strong>
          <strong v-else class="state-pill" :class="published && data.expectedDelivery ? 'done' : 'none'">{{ published && data.expectedDelivery ? '预计按期' : PLAN_STATUS_TEXT[state] }}</strong>
        </div>
        <div class="progress-num">
          <span>节点完成 <b>{{ totalProgress.done }} / {{ totalProgress.total }}</b></span>
          <span class="pct-pill">{{ totalProgress.pct }}%</span>
        </div>
      </div>

      <div class="meta">
        <span v-if="data.workOrder.customerName">客户 {{ data.workOrder.customerName }}</span>
        <span v-if="data.workOrder.projectManagerName">项目经理 {{ data.workOrder.projectManagerName }}</span>
        <span>合同交期 <b>{{ data.workOrder.deliveryDate || '—' }}</b></span>
        <span>预计交期 <b :class="{ risk: published && data.dateConflicts.length, late: published && (data.deliveryDelayDays ?? 0) > 0 }">{{ published ? (data.dateConflicts.length ? '待核实' : data.expectedDelivery || '—') : '发布后计算' }}</b></span>
        <details v-if="data.dateConflicts.length" class="review">
          <summary>查看日期问题（{{ data.dateConflicts.length }}）</summary>
          <ul><li v-for="c in data.dateConflicts" :key="c.nodeId + c.code + c.message">{{ c.message }}</li></ul>
        </details>
      </div>

      <div v-if="rulerStats" class="ruler">
        <div class="ruler-labels">
          <span>开工 {{ rulerStats.startDay }}</span>
          <span><b>今天 {{ rulerStats.todayStr }}</b>（已过 {{ rulerStats.usedDays }} / {{ rulerStats.totalDays }} 天）</span>
          <span>合同交期 {{ rulerStats.dueDay }}</span>
        </div>
        <div class="ruler-track">
          <span class="ruler-fill" :style="{ width: `${rulerStats.usedPct}%` }" />
          <span class="ruler-today" :style="{ left: `${rulerStats.usedPct}%` }" />
        </div>
      </div>
    </section>

    <template v-if="groups.phases.size">
      <!-- A2：横向阶段里程碑流水线 -->
      <div class="pipeline">
        <button
          v-for="(p, idx) in phaseSummaries"
          :key="p.phase"
          type="button"
          class="stage-card"
          :class="[`tone-${p.tone}`, { active: selectedPhase === p.phase }]"
          @click="selectedPhase = selectedPhase === p.phase ? null : p.phase"
        >
          <div class="st-top"><span>阶段 {{ idx + 1 }}</span><b :class="`text-${p.tone}`">{{ p.pct }}%</b></div>
          <div class="st-name" :title="p.phase">{{ p.phase || '计划节点' }}</div>
          <div class="st-bar"><i :class="`fill-${p.tone}`" :style="{ width: `${p.pct}%` }" /></div>
          <div class="st-foot">{{ p.done }}/{{ p.total }} · {{ p.hasSource ? '源头延误' : p.hasUpstream ? '受上游影响' : p.done === p.total && p.total > 0 ? '已完成' : '推进中' }}</div>
        </button>
      </div>

      <!-- C：部门接力进度条 + 阻塞因果链（无阻塞时部门接力铺满双列，不留大块空白） -->
      <div class="relay-grid" :class="{ single: !sources[0] && !blockedChain.length }">
        <div class="tray">
          <div class="tray-head">
            <span>各部门接力完成度</span>
            <small v-if="!sources[0] && !blockedChain.length" class="ok-badge">✓ 当前无阻塞延误</small>
            <small v-else>按叶子节点</small>
          </div>
          <div class="inset relay-list" :class="{ 'relay-cols': !sources[0] && !blockedChain.length }">
            <div v-for="d in deptRelay" :key="d.dept" class="dept-row">
              <span class="dept-name">{{ d.dept }}</span>
              <div class="dept-bar"><i :class="`fill-${d.tone}`" :style="{ width: `${d.pct}%` }" /></div>
              <span class="dept-cnt" :class="{ warn: d.late > 0 }">{{ d.done }}/{{ d.total }}</span>
            </div>
          </div>
        </div>

        <div v-if="sources[0] || blockedChain.length" class="tray">
          <div class="tray-head"><span>阻塞传导链</span><small>源头 → 下游影响</small></div>
          <div class="inset chain-box">
            <p v-if="sources[0]" class="reason">源头延误 · {{ sources[0].name }}，自身晚 {{ sources[0].selfDelayDays }} 天<span v-if="sources.length > 1">（共 {{ sources.length }} 个源头）</span></p>
            <div v-if="blockedChain.length" class="chain-row">
              <template v-for="(c, i) in blockedChain" :key="c.id">
                <span v-if="i > 0" class="arrow">→</span>
                <div class="cnode" :class="c.source ? 'late' : 'warn'">
                  <b>{{ c.code }} {{ c.name }}</b>
                  <small>{{ c.deptText }} · {{ c.source ? `晚 ${c.selfDelayDays} 天` : '顺延' }}</small>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- B：轻量级只读阶段甘特图（点击阶段展开子节点 & 任务） -->
      <div class="tray">
        <div class="tray-head">
          <span>阶段进度甘特图</span>
          <small>{{ selectedPhase ? `已筛选：${selectedPhase}（再点里程碑取消）` : '点击阶段展开子节点 · 蓝线=今天 · 红虚线=交期' }}</small>
        </div>
        <div class="inset">
          <div v-if="ganttRange" class="gantt-head">
            <div>阶段 / 节点</div>
            <div>责任部门</div>
            <div>状态</div>
            <div class="months">
              <span v-for="m in monthTicks" :key="m.label" class="tick" :style="{ left: `${m.left}%` }">{{ m.label }}</span>
            </div>
          </div>
          <details
            v-for="p in visiblePhases"
            :key="p.phase"
            class="phase"
            :open="selectedPhase === p.phase || path.phase === p.phase"
          >
            <summary>
              <div class="p-name"><b>{{ p.phase || '计划节点' }}</b> <small>{{ p.done }}/{{ p.total }}</small></div>
              <div class="p-dept">{{ p.deptText }}</div>
              <div>
                <span class="state-pill" :class="p.tone === 'primary' ? 'none' : p.tone">{{ p.hasSource ? '有延误' : p.hasUpstream ? '受影响' : p.done === p.total && p.total > 0 ? '已完成' : '按计划' }}</span>
              </div>
              <div v-if="ganttRange" class="p-gantt">
                <span v-for="m in monthTicks" :key="m.label" class="g-grid" :style="{ left: `${m.left}%` }" />
                <span class="g-today" :style="{ left: `${ganttRange.todayPct}%` }" />
                <span v-if="ganttRange.duePct != null" class="g-due" :style="{ left: `${ganttRange.duePct}%` }" />
                <template v-if="p.bar">
                  <span class="bar-plan" :style="{ left: `${p.bar.planLeft}%`, width: `${p.bar.planWidth}%` }" />
                  <span class="bar-real" :class="`fill-${p.tone}`" :style="{ left: `${p.bar.planLeft}%`, width: `${p.bar.realWidth}%` }" />
                </template>
              </div>
            </summary>
            <div class="children">
              <BoardPlanBranch
                v-for="node in p.roots"
                :key="node.id"
                :node="node"
                :children="groups.children"
                :expanded="path.ids"
                :published="published"
                :gantt="ganttRange"
              />
            </div>
          </details>
        </div>
      </div>
    </template>
    <p v-else class="empty">该工单尚未编制总计划。</p>
  </div>
</template>

<style scoped>
.progress-board { display: flex; flex-direction: column; gap: 12px; }
.root { background: var(--card-surface-bg); border: 1px solid var(--card-border); border-radius: 14px; padding: 14px 18px; box-shadow: var(--card-shadow); }
.heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.title-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
h2 { font-size: 17px; font-weight: 700; margin: 0; color: var(--ft-text); }
.wo-link { color: var(--ft-primary-text); font-weight: 600; font-size: 13px; }
.progress-num { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ft-text-2); font-variant-numeric: tabular-nums; }
.pct-pill { padding: 2px 8px; border-radius: 999px; background: var(--ft-fill); border: 1px solid var(--ft-border); font-weight: 600; color: var(--ft-text); }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; margin-top: 6px; font-size: 12.5px; color: var(--ft-text-2); font-variant-numeric: tabular-nums; }
.meta b { color: var(--ft-text); font-weight: 600; }
.meta b.risk, .risk { color: var(--ft-risk-text); }
.meta b.late, .late, .reason { color: var(--ft-late-text); }
.review summary { cursor: pointer; color: var(--ft-risk-text); font-weight: 500; font-size: 12px; }
.review ul { margin: 6px 0 0; padding-left: 18px; font-size: 12px; color: var(--ft-text-2); }

.ruler { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--card-border-subtle); }
.ruler-labels { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--ft-text-3); margin-bottom: 6px; font-variant-numeric: tabular-nums; }
.ruler-labels b { color: var(--ft-text); }
.ruler-track { position: relative; height: 7px; border-radius: 999px; background: var(--ft-fill); border: 1px solid var(--ft-border); overflow: hidden; }
.ruler-fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ft-done); border-radius: 999px; }
.ruler-today { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--ft-text); }

.pipeline { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
.stage-card { text-align: left; background: var(--card-surface-bg); border: 1px solid var(--card-hairline); border-radius: 11px; padding: 10px 11px; box-shadow: var(--card-shadow); cursor: pointer; display: flex; flex-direction: column; gap: 6px; transition: border-color 0.14s, box-shadow 0.14s, transform 0.14s; }
.stage-card:hover { border-color: var(--ft-border-hover); box-shadow: var(--card-shadow-hover); transform: translateY(-1px); }
.stage-card.active { border-color: var(--ft-primary); box-shadow: 0 0 0 1px var(--ft-primary); }
.st-top { display: flex; justify-content: space-between; font-size: 11px; color: var(--ft-text-3); font-variant-numeric: tabular-nums; }
.st-name { font-size: 12.5px; font-weight: 600; color: var(--ft-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-bar { height: 4px; border-radius: 999px; background: var(--ft-fill); overflow: hidden; }
.st-bar i { display: block; height: 100%; border-radius: 999px; }
.st-foot { font-size: 11px; color: var(--ft-text-3); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.fill-done { background: var(--ft-done); }
.fill-late { background: var(--ft-late); }
.fill-risk { background: var(--ft-risk); }
.fill-primary { background: var(--ft-primary); }
.text-done { color: var(--ft-done-text); }
.text-late { color: var(--ft-late-text); }
.text-risk { color: var(--ft-risk-text); }
.text-primary { color: var(--ft-primary-text); }

.relay-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: 12px; }
.relay-grid.single { grid-template-columns: minmax(0, 1fr); }
.tray { background: var(--card-tray-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius-outer); padding: 8px 6px 6px; }
.tray-head { display: flex; justify-content: space-between; align-items: center; padding: 2px 8px 8px; font-size: 12.5px; font-weight: 600; color: var(--ft-text); }
.tray-head small { font-size: 11.5px; font-weight: 400; color: var(--ft-text-3); }
.tray-head .ok-badge { color: var(--ft-done-text); background: var(--ft-done-bg); padding: 1px 8px; border-radius: 999px; font-weight: 500; }
.inset { background: var(--card-surface-bg); border: 1px solid var(--card-hairline); border-radius: var(--card-radius-inner); box-shadow: var(--card-shadow); overflow: hidden; }

.relay-list { padding: 4px 12px; }
.relay-list.relay-cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 24px; }
.dept-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; font-size: 12.5px; border-bottom: 1px solid var(--card-border-subtle); }
.relay-list:not(.relay-cols) .dept-row:last-child { border-bottom: none; }
.relay-list.relay-cols .dept-row:nth-last-child(-n+2) { border-bottom: none; }
.dept-name { width: 64px; flex: none; font-weight: 500; color: var(--ft-text); }
.dept-bar { flex: 1; height: 6px; border-radius: 999px; background: var(--ft-fill); overflow: hidden; }
.dept-bar i { display: block; height: 100%; border-radius: 999px; }
.dept-cnt { width: 42px; text-align: right; font-size: 12px; color: var(--ft-text-3); font-variant-numeric: tabular-nums; }
.dept-cnt.warn { color: var(--ft-risk-text); font-weight: 600; }

.chain-box { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; min-height: 100%; }
.reason { margin: 0; font-size: 12.5px; font-weight: 500; }
.chain-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cnode { background: var(--ft-fill); border: 1px solid var(--ft-border); border-radius: 8px; padding: 6px 10px; font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
.cnode.late { background: var(--ft-late-bg); border-color: var(--ft-late); }
.cnode.warn { background: var(--ft-risk-bg); border-color: var(--ft-risk); }
.cnode small { color: var(--ft-text-2); font-size: 11px; }
.arrow { color: var(--ft-text-3); font-weight: 700; }
.clean-tip { font-size: 12.5px; color: var(--ft-text-3); padding: 8px 0; }

.gantt-head { display: grid; grid-template-columns: minmax(170px, 28%) 82px 92px minmax(180px, 1fr); gap: 8px; padding: 8px 12px; font-size: 11.5px; font-weight: 600; color: var(--ft-text-3); background: var(--ft-fill); border-bottom: 1px solid var(--card-border-subtle); }
.months { position: relative; height: 16px; }
.tick { position: absolute; top: 0; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.phase { border-bottom: 1px solid var(--card-border-subtle); }
.phase:last-child { border-bottom: none; }
.phase > summary { display: grid; grid-template-columns: minmax(170px, 28%) 82px 92px minmax(180px, 1fr); align-items: center; gap: 8px; padding: 9px 12px; cursor: pointer; list-style: none; font-size: 13px; }
.phase > summary:hover { background: color-mix(in srgb, var(--ft-fill) 65%, transparent); }
.p-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.p-name::before { content: '▸'; font-size: 11px; color: var(--ft-text-3); }
.phase[open] > summary .p-name::before { content: '▾'; }
.p-name b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p-name small { font-size: 11.5px; color: var(--ft-text-3); font-variant-numeric: tabular-nums; }
.p-dept { font-size: 12px; color: var(--ft-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p-gantt { position: relative; height: 18px; }
.g-grid { position: absolute; top: -9px; bottom: -9px; border-left: 1px solid var(--card-border-subtle); }
.g-today { position: absolute; top: -9px; bottom: -9px; width: 1.5px; background: var(--ft-primary); opacity: 0.55; }
.g-due { position: absolute; top: -9px; bottom: -9px; border-left: 1.5px dashed var(--ft-late); opacity: 0.6; }
.bar-plan { position: absolute; top: 3px; height: 12px; border-radius: 4px; background: var(--ft-fill); border: 1px solid var(--ft-border); }
.bar-real { position: absolute; top: 5px; height: 8px; border-radius: 4px; }

.state-pill { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; white-space: nowrap; }
.state-pill.risk { background: var(--ft-risk-bg); color: var(--ft-risk-text); }
.state-pill.late { background: var(--ft-late-bg); color: var(--ft-late-text); }
.state-pill.done { background: var(--ft-done-bg); color: var(--ft-done-text); }
.state-pill.none { background: var(--ft-fill); color: var(--ft-text-2); }
.empty { text-align: center; margin-top: 24px; color: var(--ft-text-3); }

@media (max-width: 1120px) { .pipeline { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 900px) { .relay-grid, .relay-list.relay-cols { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 640px) { .pipeline { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 820px) {
  .gantt-head, .phase > summary { grid-template-columns: minmax(0, 1fr) auto; }
  .gantt-head > div:nth-child(2), .gantt-head > div:nth-child(4), .p-dept, .p-gantt { display: none; }
}
</style>
