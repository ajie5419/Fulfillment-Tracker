<script setup lang="ts">
/**
 * 列表行（设计改版，参考图风格）：左边 36×36 圆角图标块（状态图标），中间标题 / 说明 / 补充信息，右边放标签或数字（#extra）。
 * 放在 .ft-well 里一行接一行用，相邻两行之间自动加分隔线。compact 用于只有一两行文字的短行（垂直居中）。
 */
type Tone = 'late' | 'risk' | 'done' | 'upstream' | 'none' | 'primary'
const props = withDefaults(defineProps<{ tone?: Tone; icon?: 'alert' | 'warn' | 'check' | 'ring' | 'dot'; compact?: boolean }>(), { tone: 'none', icon: undefined, compact: false })
const DEFAULT_ICON = { late: 'alert', risk: 'warn', done: 'check', upstream: 'warn', none: 'ring', primary: 'dot' } as const
const kind = computed(() => props.icon ?? DEFAULT_ICON[props.tone])
</script>

<template>
  <div class="ft-li" :class="{ compact }">
    <span class="icon" :style="{ background: `var(--ft-${tone}-bg)` }" aria-hidden="true"><UiStatusIcon :kind="kind" :tone="tone" :size="16" /></span>
    <div class="main">
      <div class="title"><slot name="title" /></div>
      <div v-if="$slots.desc" class="desc"><slot name="desc" /></div>
      <div v-if="$slots.meta" class="meta"><slot name="meta" /></div>
    </div>
    <div v-if="$slots.extra" class="extra"><slot name="extra" /></div>
  </div>
</template>

<style scoped>
.ft-li { display: flex; align-items: flex-start; gap: 12px; padding: 14px 0; }
.ft-li + .ft-li { border-top: 1px solid var(--ft-border); }
.ft-li.compact { align-items: center; padding: 12px 0; }
.icon { flex: none; display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 10px; }
.main { flex: 1; min-width: 0; }
.title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 14px; font-weight: 500; color: var(--ft-text); }
.desc { margin-top: 4px; font-size: 13px; color: var(--ft-text); }
.meta { margin-top: 4px; font-size: 12px; color: var(--ft-text-2); }
.extra { flex: none; display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ft-text-2); white-space: nowrap; }
</style>
