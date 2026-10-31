<script setup lang="ts">
/**
 * 列表行（Ember Payouts 风格）：左边 34×34 圆角方形状态色块图标，中间主副双行信息，右边状态签或操作区（#extra）。
 * 放在单层卡片内一行接一行平铺，相邻两行之间用极细浅灰线分隔，彻底告别列表项逐条套框。
 */
type Tone = 'late' | 'risk' | 'done' | 'upstream' | 'none' | 'primary'
const props = withDefaults(defineProps<{ tone?: Tone; icon?: 'alert' | 'warn' | 'check' | 'ring' | 'dot'; compact?: boolean }>(), { tone: 'none', icon: undefined, compact: false })
const DEFAULT_ICON = { late: 'alert', risk: 'warn', done: 'check', upstream: 'warn', none: 'ring', primary: 'dot' } as const
const kind = computed(() => props.icon ?? DEFAULT_ICON[props.tone])
</script>

<template>
  <div class="ft-li" :class="[`tone-${tone}`, { compact }]">
    <span class="icon" :style="{ background: `var(--ft-${tone}-bg)` }" aria-hidden="true"><UiStatusIcon :kind="kind" :tone="tone" :size="15" /></span>
    <div class="main">
      <div class="title"><slot name="title" /></div>
      <div v-if="$slots.desc" class="desc"><slot name="desc" /></div>
      <div v-if="$slots.meta" class="meta"><slot name="meta" /></div>
    </div>
    <div v-if="$slots.extra" class="extra"><slot name="extra" /></div>
  </div>
</template>

<style scoped>
.ft-li { display: flex; align-items: flex-start; gap: 12px; padding: 13px 0; }
.ft-li + .ft-li { border-top: 1px solid var(--card-border-subtle); }
.ft-li.compact { align-items: center; padding: 11px 0; }
.icon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background-clip: padding-box;
  border: 1px solid var(--card-hairline);
  box-shadow: var(--card-badge-shadow);
}
.main { flex: 1; min-width: 0; }
.title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 14px; font-weight: 500; color: var(--ft-text); }
.desc { margin-top: 3px; font-size: 13px; color: var(--ft-text); }
.meta { margin-top: 3px; font-size: 12px; color: var(--ft-text-2); }
.extra { flex: none; display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ft-text-2); white-space: nowrap; }
</style>
