<script setup lang="ts">
/**
 * 工单号链接（前端改版第一轮）：所有页面展示工单号的地方都用它，统一跳到工单详情 /wo/:no。
 * node 给了时定位到该总计划节点（#node-<id>，详情页会展开它）。点击不冒泡（表格行本身可点时不会同时打开行详情）。
 */
const props = defineProps<{ no: string | null | undefined; node?: string | null; text?: string }>()
const to = computed(() => (props.no ? `/wo/${encodeURIComponent(props.no)}${props.node ? `#node-${props.node}` : ''}` : undefined))
</script>

<template>
  <NuxtLink v-if="to" :to="to" class="wo-link" @click.stop><slot>{{ text ?? no }}</slot></NuxtLink>
  <span v-else class="ft-muted">—</span>
</template>

<style scoped>
.wo-link { font-variant-numeric: tabular-nums; }
</style>
