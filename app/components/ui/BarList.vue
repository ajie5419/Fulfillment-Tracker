<script setup lang="ts">
/**
 * 小横条图（前端改版第一轮）：一行一项"名称 —— 横条 —— 数值文字"，条长按最大值归一。
 * 用于"谁在拖（源头延误天数）""源头延误在哪个部门"。tone 是条的颜色（默认延误红）；某一项单独给 tone 时用它的（第二轮：风险页按严重度）。
 */
const props = withDefaults(defineProps<{ items: { key: string; label: string; value: number; text?: string; tone?: string }[]; tone?: string; empty?: string; compact?: boolean; labelWidth?: number }>(), {
  tone: 'late',
  empty: '暂无',
  compact: false,
  labelWidth: undefined,
})
const max = computed(() => Math.max(0, ...props.items.map((i) => i.value)))
const barWidth = (v: number) => (v > 0 && max.value > 0 ? `${Math.max(2, Number(((v / max.value) * 100).toFixed(2)))}%` : '0%')
</script>

<template>
  <div class="ft-bars" :class="{ compact }">
    <div v-if="!items.length" class="ft-muted empty">{{ empty }}</div>
    <div v-for="it in items" :key="it.key" class="row" :style="labelWidth ? { gridTemplateColumns: `${labelWidth}px 1fr auto` } : undefined">
      <span class="label" :title="it.label">{{ it.label }}</span>
      <span class="track"><span class="fill" :class="{ nonzero: it.value > 0 }" :style="{ width: barWidth(it.value), background: `var(--ft-${it.tone ?? tone})` }" /></span>
      <span class="num">{{ it.text ?? it.value }}</span>
    </div>
  </div>
</template>

<style scoped>
.row { display: grid; grid-template-columns: 64px 1fr auto; align-items: center; gap: 10px; padding: 5px 0; font-size: 13px; }
.compact .row { grid-template-columns: 44px 1fr 28px; padding: 2px 0; font-size: 12px; gap: 8px; }
.label { color: var(--ft-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.track { height: 10px; border-radius: 5px; background: var(--ft-fill); overflow: hidden; }
.compact .track { height: 8px; }
.fill { display: block; height: 100%; border-radius: 5px; }
.fill.nonzero { min-width: 2px; }
.num { color: var(--ft-text); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.empty { font-size: 12px; }
</style>
