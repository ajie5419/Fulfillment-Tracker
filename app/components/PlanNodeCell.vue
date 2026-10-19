<script setup lang="ts">
/**
 * 列表里的"总计划节点"列（前端改版第一轮）：显示"序号. 节点名"，点击跳到工单详情并定位、展开该节点；没挂的显示灰字"未挂节点"。
 */
defineProps<{ workOrderNumber: string; node: { id: string; seq: number; name: string } | null | undefined }>()
</script>

<template>
  <WoLink v-if="node" :no="workOrderNumber" :node="node.id" :text="`${node.seq}. ${node.name}`" />
  <span v-else class="ft-muted unlinked" title="没挂到总计划节点：挂上才计入预计交期">未挂节点</span>
</template>

<style scoped>
.unlinked { font-size: 12px; }
</style>
