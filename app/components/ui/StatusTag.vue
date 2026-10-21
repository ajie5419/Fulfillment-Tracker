<script setup lang="ts">
/**
 * 状态标签（设计改版试点）：带圆点的胶囊，浅底 + 深一档文字 + 原色圆点。
 * 状态永远带文字，颜色只是辅助，所以默认插槽必填；没给文字时开发环境报警告。
 * 颜色全部走 base.css 的 --ft-* 变量，组件里不写颜色值。
 */
const props = defineProps<{ tone: 'late' | 'risk' | 'done' | 'upstream' | 'none' | 'primary' }>()
const slots = defineSlots<{ default: () => unknown }>()
if (import.meta.dev && !slots.default) console.warn('[UiStatusTag] 必须给文字，不能只靠颜色表示状态')
const style = computed(() => ({
  '--tag-bg': `var(--ft-${props.tone}-bg)`,
  '--tag-text': props.tone === 'none' ? 'var(--ft-text-2)' : `var(--ft-${props.tone}-text)`,
  '--tag-dot': `var(--ft-${props.tone})`,
}))
</script>

<template>
  <span class="ft-status-tag" :style="style"><i class="dot" aria-hidden="true" /><slot /></span>
</template>

<style scoped>
.ft-status-tag { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 10px; border-radius: 999px; font-size: 12px; font-weight: 500; line-height: 22px; white-space: nowrap; background: var(--tag-bg); color: var(--tag-text); }
.dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--tag-dot); }
</style>
