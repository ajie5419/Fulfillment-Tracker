<script setup lang="ts">
/**
 * 柱状图（设计改版，参考图风格）：放在浅灰区域里用。柱高按最大值等比例；数最大（且 > 0）的柱子用 highlight 色，
 * 其余用斜纹灰，提醒"该先看哪一项"；0 也留一截矮柱，横轴不空。给了 to 的柱子可点（键盘可聚焦）。
 */
import { NuxtLink } from '#components'
import type { RouteLocationRaw } from 'vue-router'

const props = withDefaults(defineProps<{ items: readonly { key: string; label: string; value: number; to?: RouteLocationRaw }[]; highlight?: 'late' | 'risk' | 'done' | 'primary'; height?: number }>(), { highlight: 'late', height: 260 })
const max = computed(() => Math.max(1, ...props.items.map((i) => i.value)))
const pct = (n: number) => `${Math.max(6, Math.round((n / max.value) * 100))}%`
const isTop = (n: number) => n > 0 && n === max.value
const grid = computed(() => [max.value, Math.round((max.value * 2) / 3), Math.round(max.value / 3), 0].filter((v, i, a) => a.indexOf(v) === i))
</script>

<template>
  <div class="ft-col-chart" :style="{ height: `${height}px`, '--hl': `var(--ft-${highlight})`, '--hl-text': `var(--ft-${highlight}-text, var(--ft-text))` }">
    <div class="grid" aria-hidden="true"><div v-for="v in grid" :key="v" class="line"><span>{{ v }}</span></div></div>
    <div class="cols" :style="{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }">
      <component :is="it.to ? NuxtLink : 'div'" v-for="it in items" :key="it.key" :to="it.to" class="col" :class="{ link: !!it.to }" :aria-label="`${it.label} ${it.value}`">
        <div class="track"><div class="bar" :class="{ top: isTop(it.value) }" :style="{ height: pct(it.value) }"><span class="num" :class="{ pill: isTop(it.value) }">{{ it.value }}</span></div></div>
        <div class="label">{{ it.label }}</div>
      </component>
    </div>
  </div>
</template>

<style scoped>
.ft-col-chart { position: relative; padding: 16px 16px 12px 40px; background: var(--ft-fill); border-radius: 12px; }
.grid { position: absolute; left: 40px; right: 16px; top: 16px; bottom: 40px; display: flex; flex-direction: column; justify-content: space-between; pointer-events: none; }
.line { position: relative; border-top: 1px dashed var(--ft-border); }
.line span { position: absolute; left: -28px; top: -9px; width: 20px; text-align: right; font-size: 12px; color: var(--ft-text-2); }
.cols { position: relative; height: 100%; display: grid; gap: 12px; }
.col { display: flex; flex-direction: column; min-width: 0; border-radius: 10px; color: var(--ft-text); }
.col.link:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; }
.track { flex: 1; display: flex; align-items: flex-end; justify-content: center; }
.bar { position: relative; width: 72%; max-width: 72px; border-radius: 10px; background: repeating-linear-gradient(135deg, var(--ft-card-bg) 0 5px, var(--ft-border) 5px 7px); transition: filter 0.15s; }
.bar.top { background: var(--hl); }
.col.link:hover .bar { filter: brightness(0.96); }
.num { position: absolute; left: 50%; bottom: calc(100% + 6px); transform: translateX(-50%); font-size: 13px; font-weight: 600; white-space: nowrap; }
.num.pill { padding: 1px 8px; border-radius: 8px; background: var(--ft-card-bg); border: 1px solid var(--ft-border); color: var(--hl-text); }
.label { height: 28px; margin-top: 8px; font-size: 12px; line-height: 14px; text-align: center; color: var(--ft-text-2); overflow: hidden; }
@media (max-width: 575px) {
  .ft-col-chart { padding-left: 32px; }
  .grid { left: 32px; }
  .cols { gap: 6px; }
}
</style>
