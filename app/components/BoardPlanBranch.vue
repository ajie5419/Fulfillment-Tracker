<script setup lang="ts">
import { nodeState, NODE_STATE_TEXT } from '#shared/status'
import type { PlanData } from '../composables/usePlanData'
type Node = PlanData['nodes'][number]
defineProps<{ node: Node; children: Map<string,Node[]>; expanded: Set<string>; published: boolean }>()
</script>
<template>
  <div class="item">
    <details :open="expanded.has(node.id)">
      <summary :class="{ source: published && node.source }"><b>{{ node.code }} {{ node.name }}</b>
        <small v-if="published">{{ NODE_STATE_TEXT[nodeState(node)] }}</small>
      </summary>
      <div class="facts">
        <span>{{ node.deptText }} · 计划完成 {{ node.planDate }}</span>
        <span v-if="node.actualDate">实际完成 {{ node.actualDate }}</span>
        <span v-else-if="published">预计完成 {{ node.dateConflict ? '待核实' : node.expectedDate }}</span>
        <span v-if="published && node.upstream && node.pushedBy">受 {{ node.pushedBy.code }} {{ node.pushedBy.name }} 影响</span>
        <div v-for="task in node.tasks" :key="task.kind + task.id" class="task">
          <NuxtLink :to="task.link">{{ task.name }}</NuxtLink>
          <span>{{ task.statusText }}<template v-if="task.ownerName"> · {{ task.ownerName }}</template></span>
          <span v-if="task.planDate">{{ task.dateLabel }} {{ task.planDate }}</span>
          <span v-if="task.doneDate">实际完成 {{ task.doneDate }}</span>
          <span v-else-if="task.expectedDate">预计完成 {{ task.expectedDate }}</span>
        </div>
      </div>
      <div v-if="children.has(node.id)" class="nested">
        <BoardPlanBranch v-for="child in children.get(node.id)" :key="child.id" :node="child" :children="children" :expanded="expanded" :published="published" />
      </div>
    </details>
  </div>
</template>
<style scoped>
.item { position:relative; padding-top:7px; overflow-wrap:anywhere; }.item::before { content:''; position:absolute; top:24px; left:-13px; width:13px; border-top:1px solid var(--ft-border-hover); }
summary { cursor:pointer; background:var(--ft-card-bg); border:1px solid var(--ft-border); border-radius:5px; padding:7px 9px; }
small { color:var(--ft-text-2); margin-left:5px; }.source { border-color:var(--ft-risk); }.source small { color:var(--ft-late-text); }
.facts { padding:5px 9px; color:var(--ft-text-2); font-size:12px; }.facts span { display:block; }
.task { margin-top:6px; padding-top:5px; border-top:1px solid var(--ft-border); }.task a { color:var(--ft-primary-text); }
.nested { margin-left:10px; padding-left:13px; border-left:1px solid var(--ft-border-hover); }
</style>
