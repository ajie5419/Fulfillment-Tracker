<script setup lang="ts">
import { PLAN_STATUS_TEXT, planDisplayState } from '#shared/plan'
import type { PlanData } from '../composables/usePlanData'

const props = defineProps<{ wo: string; mobile?: boolean }>()
const { data, error, refresh } = useApiFetch<PlanData>('/api/plan', {
  key: 'board-plan:' + props.wo, query: { workOrderNumber: props.wo },
})
defineExpose({ refresh })
type Node = PlanData['nodes'][number]
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
// Each column shares one trunk. Adding phases or expanding many siblings never widens the canvas.
const phaseColumns = computed(() => {
  const phases = [...groups.value.phases.entries()]
  const columnCount = Math.min(3, phases.length)
  const result: typeof phases[] = []
  let start = 0
  for (let col = 0; col < columnCount; col++) {
    const end = start + Math.ceil((phases.length - start) / (columnCount - col))
    result.push(phases.slice(start, end))
    start = end
  }
  return result
})
const sources = computed(() => published.value ? (data.value?.nodes ?? []).filter(n => n.source && !n.dateConflict)
  .sort((a,b) => Number(b.critical) - Number(a.critical) || b.selfDelayDays - a.selfDelayDays || a.seq - b.seq) : [])
const path = computed(() => {
  const ids = new Set<string>()
  const nodes = new Map(data.value?.nodes.map(n => [n.id, n]))
  let node = sources.value[0]
  let phase: string | undefined
  while (node && !ids.has(node.id)) {
    ids.add(node.id)
    phase = node.phase ?? ''
    node = node.parentId ? nodes.get(node.parentId) : undefined
  }
  return { ids, phase }
})
</script>

<template>
  <p v-if="error" role="alert">工单计划加载失败 · {{ apiError(error) }} <button @click="refresh()">重试</button></p>
  <p v-else-if="!data">正在读取总计划…</p>
  <template v-else>
    <section class="root">
      <div class="heading">
        <h2>{{ data.workOrder.projectName || wo }}</h2>
        <strong v-if="published && data.dateConflicts.length" class="state-pill risk">交期待核实</strong>
        <strong v-else-if="(data.deliveryDelayDays ?? 0) > 0 && published" class="state-pill late">预计晚 {{ data.deliveryDelayDays }} 天</strong>
        <strong v-else class="state-pill" :class="published && data.expectedDelivery ? 'done' : 'none'">{{ published && data.expectedDelivery ? '预计按期' : PLAN_STATUS_TEXT[state] }}</strong>
      </div>
      <div class="meta">
        <NuxtLink :to="mobile ? {path:'/m/plan',query:{wo}} : '/wo/' + encodeURIComponent(wo)" class="wo-link">{{ wo }}</NuxtLink>
        <span v-if="data.workOrder.customerName">{{ data.workOrder.customerName }}</span>
        <span v-if="data.workOrder.projectManagerName">· 项目经理 {{ data.workOrder.projectManagerName }}</span>
      </div>
      <div class="root-foot">
        <div class="dates">
          <span>合同交期 <b>{{ data.workOrder.deliveryDate || '—' }}</b></span>
          <span>预计交期 <b :class="{ risk: published && data.dateConflicts.length, late: published && (data.deliveryDelayDays ?? 0) > 0 }">{{ published ? (data.dateConflicts.length ? '待核实' : data.expectedDelivery || '—') : '发布后计算' }}</b></span>
        </div>
        <details v-if="data.dateConflicts.length" class="review">
          <summary>查看日期问题（{{ data.dateConflicts.length }}）</summary>
          <ul><li v-for="c in data.dateConflicts" :key="c.nodeId + c.code + c.message">{{ c.message }}</li></ul>
        </details>
      </div>
      <p v-if="sources[0]" class="reason">源头延误 · {{ sources[0].name }}，自身晚 {{ sources[0].selfDelayDays }} 天<span v-if="sources.length > 1">（共 {{ sources.length }} 个源头）</span></p>
    </section>
    <div v-if="groups.phases.size" class="tree" :class="{ vertical: mobile }" :style="{ '--phases': phaseColumns.length }">
      <section v-for="(column, i) in phaseColumns" :key="i" class="branch">
        <div class="col-stem" aria-hidden="true" />
        <div class="stack">
          <details v-for="[phase, roots] in column" :key="phase" class="phase" :open="path.phase === phase">
            <summary><span>{{ phase || '计划节点' }}</span><small>{{ roots.length }} 项</small></summary>
            <div class="children">
              <BoardPlanBranch v-for="node in roots" :key="node.id" :node="node" :children="groups.children" :expanded="path.ids" :published="published" />
            </div>
          </details>
        </div>
      </section>
    </div>
    <p v-else class="empty">该工单尚未编制总计划。</p>
  </template>
</template>

<style scoped>
.root { max-width: 480px; padding: 14px 18px; margin: auto; background: var(--card-surface-bg); border: 1px solid var(--card-border); border-radius: 14px; box-shadow: var(--card-shadow); }
.heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
h2 { font-size: 17px; font-weight: 700; margin: 0; color: var(--ft-text); }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 4px; font-size: 12.5px; color: var(--ft-text-2); }
.wo-link { color: var(--ft-primary-text); font-weight: 600; }
.root-foot { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 14px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--card-border-subtle); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.dates { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--ft-text-2); }
.dates b { font-weight: 600; color: var(--ft-text); }
.dates b.risk, .risk { color: var(--ft-risk-text); }
.dates b.late, .late, .reason { color: var(--ft-late-text); }
.reason { border-top: 1px solid var(--card-border-subtle); padding-top: 8px; margin: 8px 0 0; font-size: 12.5px; }
.state-pill { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 500; white-space: nowrap; }
.state-pill.risk { background: var(--ft-risk-bg); color: var(--ft-risk-text); }
.state-pill.late { background: var(--ft-late-bg); color: var(--ft-late-text); }
.state-pill.done { background: var(--ft-done-bg); color: var(--ft-done-text); }
.state-pill.none { background: var(--ft-fill); color: var(--ft-text-2); }

.tree { position: relative; display: grid; grid-template-columns: repeat(var(--phases), minmax(0, 1fr)); gap: 16px; padding-top: 18px; }
.tree::before { content: ''; position: absolute; top: 0; left: 50%; height: 18px; border-left: 1.5px solid var(--ft-border-hover); }
.branch { min-width: 0; position: relative; display: flex; flex-direction: column; }
.branch::before { content: ''; position: absolute; top: 0; left: -8px; right: -8px; border-top: 1.5px solid var(--ft-border-hover); }
.branch:first-child::before { left: 50%; }
.branch:last-child::before { right: 50%; }
.branch:only-child::before { display: none; }
.col-stem { align-self: center; width: 1.5px; height: 14px; background: var(--ft-border-hover); flex: none; }
.stack { display: flex; flex-direction: column; gap: 10px; }

.phase { background: var(--card-tray-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius-outer); padding: 6px; }
.phase > summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; padding: 5px 8px; font-size: 13px; font-weight: 600; color: var(--ft-text); border-radius: 8px; list-style: none; }
.phase > summary::before { content: '▸'; font-size: 11px; color: var(--ft-text-3); margin-right: 4px; }
.phase[open] > summary::before { content: '▾'; }
.phase > summary span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.phase > summary small { color: var(--ft-text-3); font-size: 11.5px; font-weight: 500; white-space: nowrap; }
.children { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }

.empty { text-align: center; margin-top: 24px; color: var(--ft-text-3); }
.review summary { cursor: pointer; color: var(--ft-risk-text); font-weight: 500; font-size: 12px; }
.review ul { margin: 6px 0 0; padding-left: 18px; font-size: 12px; color: var(--ft-text-2); }
.vertical { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; }
.vertical::before, .vertical .branch::before, .vertical .col-stem { display: none; }
@media (max-width: 1000px) {
  .tree { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; }
  .tree::before, .branch::before, .col-stem { display: none; }
}
</style>
