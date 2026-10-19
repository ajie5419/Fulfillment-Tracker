<script setup lang="ts">
/**
 * 按工单分组的组标题（前端改版第二轮，部门工作台）：工单号（WoLink）+ 组里挂的总计划节点 + 本组完成度小进度条（如"到货 1/2"）+ 条数。
 * 节点多时只列前 2 个，其余"等 N 个"。
 */
const props = withDefaults(
  defineProps<{
    no: string
    nodes?: { id: string; seq: number; name: string }[]
    done: number
    total: number
    /** 完成度的说法：到货、出图完成、已签收、已付 */
    label: string
    count: number
    unit?: string
  }>(),
  { nodes: () => [], unit: '项' },
)
const pct = computed(() => (props.total ? Math.round((props.done / props.total) * 100) : 0))
</script>

<template>
  <div class="ft-group-head">
    <span class="wo"><WoLink :no="no" /></span>
    <span v-if="nodes.length" class="nodes">
      总计划节点
      <template v-for="(n, i) in nodes.slice(0, 2)" :key="n.id"><template v-if="i">、</template><WoLink :no="no" :node="n.id" :text="`${n.seq}. ${n.name}`" /></template>
      <template v-if="nodes.length > 2"> 等 {{ nodes.length }} 个</template>
    </span>
    <span class="prog" :title="`${label} ${done}/${total}`">
      <span class="track"><span class="fill" :class="{ full: total && done === total }" :style="{ width: `${pct}%` }" /></span>
      <span class="txt">{{ label }} {{ done }}/{{ total }}</span>
    </span>
    <span class="count">{{ count }} {{ unit }}</span>
  </div>
</template>

<style scoped>
.ft-group-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 16px; padding: 8px 12px; margin-bottom: 6px; border-radius: 8px; background: var(--ft-fill); font-size: 13px; color: var(--ft-text-2); }
.wo { font-size: 14px; font-weight: 600; }
.nodes { min-width: 0; }
.prog { display: inline-flex; align-items: center; gap: 8px; }
.track { width: 96px; height: 6px; border-radius: 3px; background: #dfe4eb; overflow: hidden; }
.fill { display: block; height: 100%; background: var(--ft-primary); border-radius: 3px; }
.fill.full { background: var(--ft-done); }
.txt { white-space: nowrap; color: var(--ft-text); font-variant-numeric: tabular-nums; }
.count { margin-left: auto; color: var(--ft-text-3); font-size: 12px; }
</style>
