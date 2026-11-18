<script setup lang="ts">
import { nodeState, NODE_STATE_TEXT } from '#shared/status'
import type { PlanData } from '../composables/usePlanData'
type Node = PlanData['nodes'][number]
const props = defineProps<{ node: Node; children: Map<string,Node[]>; expanded: Set<string>; published: boolean }>()
const stateKey = computed(() => (props.published ? nodeState(props.node) : 'ON_TRACK'))
</script>
<template>
  <div class="item">
    <details :open="expanded.has(node.id)">
      <summary :class="{ source: published && node.source }">
        <span class="node-left">
          <i class="dot" :class="`dot-${stateKey}`" aria-hidden="true" />
          <b class="node-name">{{ node.code }} {{ node.name }}</b>
        </span>
        <small v-if="published" class="state-pill" :class="`pill-${stateKey}`">{{ NODE_STATE_TEXT[stateKey] }}</small>
      </summary>
      <div class="facts">
        <div class="fact-line">
          <span>{{ node.deptText }}</span>
          <span>· 计划 {{ node.planDate }}</span>
          <span v-if="node.actualDate">· 实际 {{ node.actualDate }}</span>
          <span v-else-if="published">· 预计 {{ node.dateConflict ? '待核实' : node.expectedDate }}</span>
        </div>
        <div v-if="published && node.upstream && node.pushedBy" class="pushed">受 {{ node.pushedBy.code }} {{ node.pushedBy.name }} 影响</div>
        <div v-for="task in node.tasks" :key="task.kind + task.id" class="task">
          <NuxtLink :to="task.link">{{ task.name }}</NuxtLink>
          <span> · {{ task.statusText }}<template v-if="task.ownerName">（{{ task.ownerName }}）</template></span>
          <span v-if="task.doneDate"> · 实际 {{ task.doneDate }}</span>
          <span v-else-if="task.expectedDate"> · 预计 {{ task.expectedDate }}</span>
        </div>
      </div>
      <div v-if="children.has(node.id)" class="nested">
        <BoardPlanBranch v-for="child in children.get(node.id)" :key="child.id" :node="child" :children="children" :expanded="expanded" :published="published" />
      </div>
    </details>
  </div>
</template>
<style scoped>
.item { background: var(--card-surface-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius-inner); overflow-wrap: anywhere; }
summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; padding: 8px 10px; list-style: none; }
.node-left { display: flex; align-items: center; gap: 6px; min-width: 0; }
.node-name { font-size: 12.5px; font-weight: 600; color: var(--ft-text); }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--ft-primary); }
.dot-DONE { background: var(--ft-done); }
.dot-SOURCE { background: var(--ft-late); }
.dot-UPSTREAM { background: var(--ft-risk); }
.dot-ON_TRACK { background: var(--ft-primary); }
.state-pill { flex: none; display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 500; white-space: nowrap; background: var(--ft-fill); color: var(--ft-text-2); }
.pill-DONE { background: var(--ft-done-bg); color: var(--ft-done-text); }
.pill-SOURCE { background: var(--ft-late-bg); color: var(--ft-late-text); }
.pill-UPSTREAM { background: var(--ft-risk-bg); color: var(--ft-risk-text); }
.pill-ON_TRACK { background: var(--ft-primary-bg); color: var(--ft-primary-text); }
.source { background: color-mix(in srgb, var(--ft-late-bg) 30%, var(--card-surface-bg)); border-radius: var(--card-radius-inner); }
.facts { padding: 0 10px 8px 22px; color: var(--ft-text-3); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.fact-line { display: flex; flex-wrap: wrap; gap: 4px; }
.pushed { color: var(--ft-risk-text); margin-top: 2px; }
.task { margin-top: 5px; padding-top: 5px; border-top: 1px solid var(--card-border-subtle); font-size: 12px; color: var(--ft-text-2); }
.task a { color: var(--ft-primary-text); font-weight: 500; }
.nested { display: flex; flex-direction: column; gap: 6px; padding: 0 8px 8px 14px; }
</style>
