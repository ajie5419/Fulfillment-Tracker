<script setup lang="ts">
import { computed } from 'vue'
import { nodeState, NODE_STATE_TEXT } from '#shared/status'
import type { PlanData } from '../composables/usePlanData'

type Node = PlanData['nodes'][number]
export interface GanttRange {
  minMs: number
  spanMs: number
  todayPct: number
  duePct: number | null
}

const props = defineProps<{
  node: Node
  children: Map<string, Node[]>
  expanded: Set<string>
  published: boolean
  gantt?: GanttRange | null
}>()

const stateKey = computed(() => (props.published ? nodeState(props.node) : 'ON_TRACK'))
const DAY_MS = 86_400_000
const toMs = (d?: string | null) => (d ? Date.parse(`${d}T00:00:00Z`) : Number.NaN)
const pct = (ms: number, g: GanttRange) => Math.max(0, Math.min(100, ((ms - g.minMs) / g.spanMs) * 100))

const bars = computed(() => {
  const g = props.gantt
  if (!g) return null
  const pEnd = toMs(props.node.planDate)
  if (!Number.isFinite(pEnd)) return null
  const pStart = toMs(props.node.startDate)
  const sMs = Number.isFinite(pStart) ? pStart : pEnd
  const pLeft = pct(sMs, g)
  const pRight = pct(pEnd + DAY_MS, g)
  const realEndStr = props.node.actualDate ?? (props.published && !props.node.dateConflict ? props.node.expectedDate : props.node.planDate)
  const rEnd = toMs(realEndStr)
  const rRight = Number.isFinite(rEnd) ? pct(rEnd + DAY_MS, g) : pRight
  return {
    planStyle: { left: `${pLeft}%`, width: `${Math.max(1.2, pRight - pLeft)}%` },
    realStyle: { left: `${pLeft}%`, width: `${Math.max(1.2, rRight - pLeft)}%` },
  }
})
</script>

<template>
  <div class="item">
    <details :open="expanded.has(node.id)">
      <summary :class="{ source: published && node.source }">
        <div class="col-name">
          <i class="dot" :class="`dot-${stateKey}`" aria-hidden="true" />
          <b class="node-name">{{ node.code }} {{ node.name }}</b>
        </div>
        <div class="col-dept">{{ node.deptText }}</div>
        <div class="col-state">
          <small v-if="published" class="state-pill" :class="`pill-${stateKey}`">{{ NODE_STATE_TEXT[stateKey] }}</small>
          <small v-else class="state-pill">草稿</small>
        </div>
        <div v-if="gantt" class="col-gantt">
          <span class="g-today" :style="{ left: `${gantt.todayPct}%` }" />
          <span v-if="gantt.duePct != null" class="g-due" :style="{ left: `${gantt.duePct}%` }" />
          <template v-if="bars">
            <span class="bar-plan" :style="bars.planStyle" />
            <span class="bar-real" :class="`bar-${stateKey}`" :style="bars.realStyle" />
          </template>
        </div>
      </summary>
      <div class="facts">
        <div class="fact-line">
          <span>{{ node.deptText }}</span>
          <span v-if="node.planDate">· 计划 {{ node.planDate }}</span>
          <span v-if="node.actualDate">· 实际 {{ node.actualDate }}</span>
          <span v-else-if="published && node.expectedDate">· 预计 {{ node.dateConflict ? '待核实' : node.expectedDate }}</span>
          <span v-if="published && node.upstream && node.pushedBy" class="pushed">· 受 {{ node.pushedBy.code }} {{ node.pushedBy.name }} 影响</span>
        </div>
        <div v-for="task in node.tasks" :key="task.kind + task.id" class="task">
          <NuxtLink :to="task.link">{{ task.name }}</NuxtLink>
          <span> · {{ task.statusText }}<template v-if="task.ownerName">（{{ task.ownerName }}）</template></span>
          <span v-if="task.doneDate"> · 实际 {{ task.doneDate }}</span>
          <span v-else-if="task.expectedDate"> · 预计 {{ task.expectedDate }}</span>
        </div>
      </div>
      <div v-if="children.has(node.id)" class="nested">
        <BoardPlanBranch
          v-for="child in children.get(node.id)"
          :key="child.id"
          :node="child"
          :children="children"
          :expanded="expanded"
          :published="published"
          :gantt="gantt"
        />
      </div>
    </details>
  </div>
</template>

<style scoped>
.item { border-top: 1px solid var(--card-border-subtle); overflow-wrap: anywhere; }
summary {
  display: grid;
  grid-template-columns: minmax(170px, 28%) 82px 92px minmax(180px, 1fr);
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 7px 12px 7px 26px;
  list-style: none;
  transition: background-color 0.12s;
}
summary:hover { background: color-mix(in srgb, var(--ft-fill) 65%, transparent); }
.col-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.node-name { font-size: 12.5px; font-weight: 500; color: var(--ft-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-dept { font-size: 12px; color: var(--ft-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-state { display: flex; align-items: center; }
.col-gantt { position: relative; height: 18px; }
.g-today { position: absolute; top: -8px; bottom: -8px; width: 1.5px; background: var(--ft-primary); opacity: 0.5; }
.g-due { position: absolute; top: -8px; bottom: -8px; border-left: 1.5px dashed var(--ft-late); opacity: 0.6; }
.bar-plan { position: absolute; top: 3px; height: 12px; border-radius: 4px; background: var(--ft-fill); border: 1px solid var(--ft-border); }
.bar-real { position: absolute; top: 5px; height: 8px; border-radius: 4px; background: var(--ft-primary); }
.bar-DONE { background: var(--ft-done); }
.bar-SOURCE { background: var(--ft-late); }
.bar-UPSTREAM { background: var(--ft-risk); }
.bar-ON_TRACK { background: var(--ft-primary); }

.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--ft-primary); }
.dot-DONE { background: var(--ft-done); }
.dot-SOURCE { background: var(--ft-late); }
.dot-UPSTREAM { background: var(--ft-risk); }
.dot-ON_TRACK { background: var(--ft-primary); }
.state-pill { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 500; white-space: nowrap; background: var(--ft-fill); color: var(--ft-text-2); }
.pill-DONE { background: var(--ft-done-bg); color: var(--ft-done-text); }
.pill-SOURCE { background: var(--ft-late-bg); color: var(--ft-late-text); }
.pill-UPSTREAM { background: var(--ft-risk-bg); color: var(--ft-risk-text); }
.pill-ON_TRACK { background: var(--ft-primary-bg); color: var(--ft-primary-text); }
.source { background: color-mix(in srgb, var(--ft-late-bg) 28%, transparent); }

.facts { padding: 4px 12px 8px 38px; color: var(--ft-text-3); font-size: 12px; font-variant-numeric: tabular-nums; }
.fact-line { display: flex; flex-wrap: wrap; gap: 4px; }
.pushed { color: var(--ft-risk-text); }
.task { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--card-border-subtle); color: var(--ft-text-2); }
.task a { color: var(--ft-primary-text); font-weight: 500; }
.nested :deep(summary) { padding-left: 38px; }

@media (max-width: 820px) {
  summary { grid-template-columns: minmax(0, 1fr) auto; padding-left: 16px; }
  .col-dept, .col-gantt { display: none; }
}
</style>
