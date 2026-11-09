<script setup lang="ts">
/**
 * 列表里的"总计划节点"列（前端改版第一轮）：显示"序号. 节点名"，点击跳到工单详情并定位、展开该节点；没挂的显示灰字"未挂节点"。
 */
defineProps<{ workOrderNumber: string; node: { id: string; seq: number; name: string; code?: string } | null | undefined }>()
</script>

<template>
  <NuxtLink
    v-if="node"
    :to="{ path: `/wo/${encodeURIComponent(workOrderNumber)}`, query: { tab: 'plan', node: node.id } }"
    class="node-cell-link"
  >
    <span class="node-code">{{ node.code ?? node.seq }}</span>
    <span class="node-name">{{ node.name }}</span>
  </NuxtLink>
  <span v-else class="ft-muted unlinked" title="没挂到总计划节点：挂上才计入预计交期">未挂节点</span>
</template>

<style scoped>
.node-cell-link { display: inline-flex; align-items: center; gap: 6px; color: var(--ft-text-2); text-decoration: none; max-width: 100%; }
.node-cell-link:hover { color: var(--ft-primary); }
.node-code { flex: none; padding: 0 5px; height: 19px; line-height: 19px; border-radius: 4px; background: var(--ft-fill); border: 1px solid var(--ft-border); color: var(--ft-text-2); font-size: 11px; font-weight: 500; font-variant-numeric: tabular-nums; }
.node-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.unlinked { font-size: 12px; }
</style>
