<script setup lang="ts">
/** 环形进度（前端改版第一轮，手写 SVG）：value / total，中间显示文字（默认"value/total"） */
const props = withDefaults(defineProps<{ value: number; total: number; size?: number; stroke?: number; color?: string; label?: string }>(), {
  size: 64,
  stroke: 8,
  color: 'var(--ft-primary)',
  label: undefined,
})
const r = computed(() => (props.size - props.stroke) / 2)
const c = computed(() => 2 * Math.PI * r.value)
const frac = computed(() => (props.total > 0 ? Math.min(1, Math.max(0, props.value / props.total)) : 0))
</script>

<template>
  <svg class="ft-ring" :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" role="img" :aria-label="label ?? `${value}/${total}`">
    <circle :cx="size / 2" :cy="size / 2" :r="r" fill="none" stroke="var(--ft-fill)" :stroke-width="stroke" />
    <circle
      v-if="frac > 0"
      :cx="size / 2"
      :cy="size / 2"
      :r="r"
      fill="none"
      :stroke="color"
      :stroke-width="stroke"
      stroke-linecap="round"
      :stroke-dasharray="`${(c * frac).toFixed(2)} ${c.toFixed(2)}`"
      :transform="`rotate(-90 ${size / 2} ${size / 2})`"
    />
    <text :x="size / 2" :y="size / 2" text-anchor="middle" dominant-baseline="central" class="txt">{{ label ?? `${value}/${total}` }}</text>
  </svg>
</template>

<style scoped>
.ft-ring { flex: none; }
.txt { font-size: 15px; font-weight: 600; fill: var(--ft-text); }
</style>
