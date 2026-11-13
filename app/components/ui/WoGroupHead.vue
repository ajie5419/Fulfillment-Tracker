<script setup lang="ts">
/**
 * 按工单分组的托盘标题栏（Brick 风格）：
 * 左侧：折叠徽标 + 工单号（WoLink）+ 组内关联的总计划节点；
 * 右侧：微型进度条 + 完成度（如"1/5 已完成"）+ 条数统计。
 */
const props = withDefaults(
  defineProps<{
    no: string
    nodes?: { id: string; seq: number; name: string; code?: string }[]
    done: number
    total: number
    /** 完成度的说法：到货、设计完成、已签收、已付 */
    label: string
    count: number
    matchedCount?: number
    unit?: string
  }>(),
  { nodes: () => [], unit: '项' },
)
const MAX_INLINE_NODES = 2
const pct = computed(() => (props.total ? Math.round((props.done / props.total) * 100) : 0))
</script>

<template>
  <div class="ft-group-head">
    <div class="head-left">
      <span class="tray-chevron" aria-hidden="true">⌄</span>
      <span class="wo"><WoLink :no="no" /></span>
      <template v-if="nodes.length">
        <span class="sep" aria-hidden="true">/</span>
        <span class="nodes">
          总计划节点
          <template v-for="(n, i) in nodes.slice(0, MAX_INLINE_NODES)" :key="n.id"><template v-if="i">、</template><WoLink :no="no" :node="n.id" :text="`${n.code ?? n.seq} ${n.name}`" /></template>
          <template v-if="nodes.length > MAX_INLINE_NODES"> 等 {{ nodes.length }} 个</template>
        </span>
      </template>
    </div>

    <div class="head-right">
      <span class="prog" :title="`${label} ${done}/${total}`">
        <span class="track"><span class="fill" :style="{ width: `${pct}%` }" /></span>
        <span class="txt">{{ label }} {{ done }}/{{ total }}</span>
      </span>
      <span class="count">{{ matchedCount == null ? `${count} ${unit}` : `本页 ${count} / 匹配共 ${matchedCount} ${unit}` }}</span>
    </div>
  </div>
</template>

<style scoped>
.ft-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding: 2px 6px 10px;
  font-size: 13px;
  color: var(--ft-text-2);
}
.head-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.tray-chevron {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--ft-card-bg);
  border: 1px solid var(--ft-border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--ft-text-2);
  font-size: 11px;
  line-height: 1;
  flex-shrink: 0;
}
.wo {
  font-size: 14px;
  font-weight: 600;
}
.sep {
  color: var(--ft-border-hover);
}
.nodes {
  min-width: 0;
  color: var(--ft-text-2);
  font-size: 12.5px;
}
.head-right {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
}
.prog {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.track {
  width: 48px;
  height: 6px;
  border-radius: 999px;
  background: var(--ft-border-hover);
  overflow: hidden;
}
.fill {
  display: block;
  height: 100%;
  background: var(--ft-done);
  border-radius: 999px;
}
.txt {
  white-space: nowrap;
  color: var(--ft-text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.count {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--ft-card-bg);
  border: 1px solid var(--ft-border);
  color: var(--ft-text-2);
  font-size: 12px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
</style>
