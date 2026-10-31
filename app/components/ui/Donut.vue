<script setup lang="ts">
/**
 * 环形图 + 图例（设计改版，参考图风格）：几段按占比画，中间是合计和一句说明；右边图例逐项列"名称 占比 数量"。
 * 颜色用状态色（tone），状态同时由图例文字表达。给了 to 的图例项可点。
 */
import { NuxtLink } from '#components'
import type { RouteLocationRaw } from 'vue-router'

type Tone = 'late' | 'risk' | 'done' | 'upstream' | 'none' | 'primary'
const props = withDefaults(defineProps<{ segments: readonly { key: string; label: string; value: number; tone: Tone; to?: RouteLocationRaw }[]; caption?: string; height?: number }>(), { caption: '合计', height: 260 })
const total = computed(() => props.segments.reduce((n, s) => n + s.value, 0))
function pct(n: number) {
  if (!total.value) return '0%'
  const p = (n / total.value) * 100
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
}
/** 周长由 SVG pathLength="100" 归一，dasharray 直接用百分数；从 12 点钟方向开始，跳过 0 值段 */
const arcs = computed(() => {
  let offset = 0
  return props.segments
    .map((s) => {
      const len = total.value ? (s.value / total.value) * 100 : 0
      const a = { ...s, len, offset }
      offset += len
      return a
    })
    .filter((a) => a.len > 0)
})
</script>

<template>
  <div class="ft-donut" :style="{ minHeight: `${height}px` }">
    <svg class="ring" viewBox="0 0 42 42" role="img" :aria-label="`${caption} ${total}`">
      <circle class="bg" cx="21" cy="21" r="15.915" pathLength="100" />
      <circle v-for="a in arcs" :key="a.key" class="seg" :style="{ stroke: `var(--ft-${a.tone})` }" cx="21" cy="21" r="15.915" pathLength="100" :stroke-dasharray="`${a.len} ${100 - a.len}`" :stroke-dashoffset="25 - a.offset" />
      <text x="21" y="22.5" class="num">{{ total }}</text>
      <text x="21" y="27" class="cap">{{ caption }}</text>
    </svg>
    <div class="legend">
      <component :is="s.to ? NuxtLink : 'div'" v-for="s in segments" :key="s.key" :to="s.to" class="item" :class="{ link: !!s.to }">
        <i class="tick" :style="{ background: `var(--ft-${s.tone})` }" aria-hidden="true" /><span class="name" :title="s.label">{{ s.label }}</span><span class="pct">{{ pct(s.value) }}</span><b>{{ s.value }}</b>
      </component>
    </div>
  </div>
</template>

<style scoped>
.ft-donut { display: flex; align-items: center; gap: 24px; padding: 16px; background: var(--ft-fill); border-radius: 12px; }
.ring { flex: none; width: 190px; height: 190px; }
.bg { fill: none; stroke: var(--ft-border); stroke-width: 6; }
.seg { fill: none; stroke-width: 6; }
.num { font-size: 7px; font-weight: 600; text-anchor: middle; fill: var(--ft-text); font-variant-numeric: tabular-nums; }
.cap { font-size: 2.6px; text-anchor: middle; fill: var(--ft-text-2); }
.legend { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.item { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: var(--ft-card-bg); border: 1px solid var(--ft-border); border-radius: 10px; color: var(--ft-text); font-size: 13px; white-space: nowrap; min-width: 0; }
.item.link:hover { color: var(--ft-text); border-color: var(--ft-text-3); }
.item.link:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; }
.tick { flex: none; width: 3px; height: 13px; border-radius: 2px; }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.pct { flex: none; color: var(--ft-text-2); font-variant-numeric: tabular-nums; }
.item b { flex: none; font-weight: 600; font-variant-numeric: tabular-nums; }
@media (max-width: 575px) {
  .ft-donut { flex-direction: column; }
  .legend { width: 100%; }
}
</style>
