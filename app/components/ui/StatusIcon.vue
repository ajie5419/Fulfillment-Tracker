<script setup lang="ts">
/**
 * 状态小图标（前端改版第一轮）：配合文字用，颜色按 tone。图标形状本身也区分状态（不只靠颜色）：
 *   alert 实心圆加"!"（红 / 延误）、warn 三角加"!"（黄 / 有风险）、check 对勾（正常 / 已完成）、ring 空心圆（未开始 / 未建计划）、dot 实心圆点。
 */
const props = withDefaults(defineProps<{ kind: 'alert' | 'warn' | 'check' | 'ring' | 'dot'; tone?: string; size?: number }>(), { tone: undefined, size: 14 })
const DEFAULT_TONE = { alert: 'late', warn: 'risk', check: 'done', ring: 'none', dot: 'primary' } as const
const color = computed(() => `var(--ft-${({ primary: 'primary', late: 'late', risk: 'risk', done: 'done', upstream: 'upstream', none: 'none', onTrack: 'on-track' } as Record<string, string>)[props.tone ?? DEFAULT_TONE[props.kind]] ?? 'primary'})`)
</script>

<template>
  <svg class="ft-icon" :width="size" :height="size" viewBox="0 0 16 16" aria-hidden="true" :style="{ color }">
    <template v-if="kind === 'alert'">
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <rect x="7.1" y="3.6" width="1.8" height="5.6" rx="0.9" fill="#fff" />
      <circle cx="8" cy="11.6" r="1.05" fill="#fff" />
    </template>
    <template v-else-if="kind === 'warn'">
      <path d="M8 1.6 15.2 14.2H.8Z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round" />
      <rect x="7.15" y="5.6" width="1.7" height="4.6" rx="0.85" fill="#fff" />
      <circle cx="8" cy="12.1" r="0.95" fill="#fff" />
    </template>
    <path v-else-if="kind === 'check'" d="M2.5 8.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
    <circle v-else-if="kind === 'ring'" cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="2" />
    <circle v-else cx="8" cy="8" r="5" fill="currentColor" />
  </svg>
</template>

<style scoped>
.ft-icon { flex: none; display: inline-block; vertical-align: -2px; }
</style>
