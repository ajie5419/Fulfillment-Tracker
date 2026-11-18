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
      <div class="heading"><h2>{{ data.workOrder.projectName || wo }}</h2>
        <strong v-if="published && data.dateConflicts.length" class="risk">交期待核实</strong>
        <strong v-else-if="(data.deliveryDelayDays ?? 0) > 0 && published" class="late">预计晚 {{ data.deliveryDelayDays }} 天</strong>
        <strong v-else>{{ published && data.expectedDelivery ? '预计按期' : PLAN_STATUS_TEXT[state] }}</strong>
      </div>
      <div class="meta"><NuxtLink :to="mobile ? {path:'/m/plan',query:{wo}} : '/wo/' + encodeURIComponent(wo)">{{ wo }}</NuxtLink>
        <span v-if="data.workOrder.customerName">{{ data.workOrder.customerName }}</span>
        <span v-if="data.workOrder.projectManagerName">项目经理 {{ data.workOrder.projectManagerName }}</span></div>
      <div class="dates"><span>合同交期 <b>{{ data.workOrder.deliveryDate || '—' }}</b></span>
        <span>预计交期 <b>{{ published ? (data.dateConflicts.length ? '待核实' : data.expectedDelivery || '—') : '发布后计算' }}</b></span></div>
      <p v-if="sources[0]" class="reason">源头延误 · {{ sources[0].name }}，自身晚 {{ sources[0].selfDelayDays }} 天<span v-if="sources.length > 1">（共 {{ sources.length }} 个源头）</span></p>
      <details v-if="data.dateConflicts.length" class="review"><summary>查看日期问题（{{ data.dateConflicts.length }}）</summary>
        <ul><li v-for="c in data.dateConflicts" :key="c.nodeId + c.code + c.message">{{ c.message }}</li></ul>
      </details>
    </section>
    <div v-if="groups.phases.size" class="tree" :class="{ vertical: mobile }" :style="{ '--phases': phaseColumns.length }">
      <section v-for="(column, i) in phaseColumns" :key="i" class="branch">
        <div class="stack"><details v-for="[phase, roots] in column" :key="phase" class="phase" :open="path.phase === phase"><summary>{{ phase || '计划节点' }} <small>{{ roots.length }} 项</small></summary>
          <div class="children">
            <BoardPlanBranch v-for="node in roots" :key="node.id" :node="node" :children="groups.children" :expanded="path.ids" :published="published" />
          </div>
        </details></div>
      </section>
    </div>
    <p v-else class="empty">该工单尚未编制总计划。</p>
  </template>
</template>

<style scoped>
.root { max-width:510px; padding:16px 18px; margin:auto; background:var(--ft-card-bg); border:1px solid var(--ft-border-hover); border-top:3px solid var(--ft-text-2); border-radius:8px; }
.heading,.meta,.dates { display:flex; align-items:baseline; flex-wrap:wrap; gap:4px 12px; }.heading { justify-content:space-between; }
h2 { font-size:19px; margin:0; }.heading strong,small,.meta { font-size:12px; }.meta { margin-top:4px; color:var(--ft-text-3); }
.dates { margin-top:12px; font-size:13px; }.dates b { font-weight:500; }.reason { border-top:1px solid var(--ft-border); padding-top:7px; margin:8px 0 0; }
.late,.reason { color:var(--ft-late-text); }.risk { color:var(--ft-risk-text); }
.tree { position:relative; display:grid; grid-template-columns:repeat(var(--phases),minmax(0,1fr)); padding-top:20px; }
.tree::before,.branch::before,.branch::after { content:''; position:absolute; }
.tree::before,.branch::after { top:0; left:50%; height:20px; border-left:1px solid var(--ft-border-hover); }
.branch { min-width:0; position:relative; padding:0 6px; }
.branch::after { display:none; }
.stack { border-left:1px solid var(--ft-border-hover); }
.phase { position:relative; padding:12px 0 0 12px; }.phase::before { content:''; position:absolute; top:30px; left:0; width:12px; border-top:1px solid var(--ft-border-hover); }
.branch::before { top:0; left:0; right:0; border-top:1px solid var(--ft-border-hover); }
.branch:first-child::before { left:6px; }.branch:last-child::before { right:calc(100% - 6px); }.branch:only-child::before { left:6px; right:50%; }
summary { cursor:pointer; background:var(--ft-card-bg); border:1px solid var(--ft-border); border-radius:6px; padding:9px; font-weight:600; overflow-wrap:anywhere; }
small { color:var(--ft-text-3); font-weight:400; white-space:nowrap; }.children { margin-left:10px; border-left:1px solid var(--ft-border-hover); padding-left:13px; }
.empty { text-align:center; margin-top:24px; color:var(--ft-text-3); }
.review { margin-top:8px; }.review summary { border:0; padding:0; color:var(--ft-risk-text); font-weight:400; font-size:12px; }.review ul { padding-left:20px; font-size:12px; }
.vertical { display:block; padding:0 0 0 12px; }.vertical::before,.vertical .branch::before { display:none; }
@media(max-width:1000px) {
  .tree { display:block; padding:0 0 0 12px; }.tree::before,.tree .branch::before { display:none; }
}
</style>
