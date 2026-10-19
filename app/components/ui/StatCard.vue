<script setup lang="ts">
/**
 * 统计卡（前端改版第一轮）：标签 + 大数字（+ 单位）+ 补充说明（#sub 或 sub）。
 * tone 决定顶部色条和图标颜色（late 延误红 / risk 有风险黄 / done 正常绿 / upstream 受上游影响橙 / none 灰 / primary 主色）；
 * 状态永远带文字（label），颜色只是辅助。给了 to 时整张卡可点击；
 * 第二轮：clickable 时整张卡是按钮（点了在本页套用筛选，触发 click），键盘回车 / 空格也能点。
 */
import type { RouteLocationRaw } from 'vue-router'
import { NuxtLink } from '#components'

const props = withDefaults(
  defineProps<{
    label: string
    value?: string | number | null
    unit?: string
    sub?: string
    tone?: 'late' | 'risk' | 'done' | 'upstream' | 'none' | 'primary'
    /** 顶部色条 */
    accent?: boolean
    /** 标签前的状态图标 */
    icon?: 'alert' | 'warn' | 'check' | 'ring' | 'dot' | null
    to?: RouteLocationRaw
    active?: boolean
    clickable?: boolean
  }>(),
  { value: null, unit: undefined, sub: undefined, tone: undefined, accent: false, icon: null, to: undefined, active: false, clickable: false },
)
const emit = defineEmits<{ click: [e: MouseEvent | KeyboardEvent] }>()
const tag = computed(() => (props.to ? NuxtLink : 'div'))
const asButton = computed(() => !props.to && props.clickable)
function onKey(e: KeyboardEvent) {
  if (!asButton.value) return
  e.preventDefault()
  emit('click', e)
}
</script>

<template>
  <component
    :is="tag"
    :to="to"
    class="ft-stat"
    :class="[tone ? `tone-${tone}` : '', { accent, link: !!to || clickable, active }]"
    :role="asButton ? 'button' : undefined"
    :tabindex="asButton ? 0 : undefined"
    :aria-pressed="asButton ? active : undefined"
    @click="emit('click', $event)"
    @keydown.enter="onKey"
    @keydown.space="onKey"
  >
    <div class="label">
      <UiStatusIcon v-if="icon" :kind="icon" :tone="tone" />
      <span>{{ label }}</span>
    </div>
    <div v-if="value != null || $slots.value" class="value">
      <slot name="value"><b>{{ value }}</b><span v-if="unit" class="unit">{{ unit }}</span></slot>
    </div>
    <div v-if="sub || $slots.sub || $slots.default" class="sub"><slot name="sub">{{ sub }}</slot><slot /></div>
  </component>
</template>

<style scoped>
.ft-stat { display: block; position: relative; background: var(--ft-card-bg); border-radius: var(--ft-card-radius); box-shadow: var(--ft-card-shadow); padding: 16px 20px; color: var(--ft-text); min-width: 0; overflow: hidden; }
.ft-stat.link { cursor: pointer; transition: box-shadow 0.15s; }
.ft-stat.link:hover { box-shadow: 0 2px 4px rgba(16, 24, 40, 0.06), 0 6px 16px rgba(16, 24, 40, 0.08); color: var(--ft-text); }
.ft-stat.active { outline: 2px solid var(--ft-primary); }
.ft-stat.link:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; }
.accent::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 4px; background: var(--ft-none); }
.accent.tone-late::before { background: var(--ft-late); }
.accent.tone-risk::before { background: var(--ft-risk); }
.accent.tone-done::before { background: var(--ft-done); }
.accent.tone-upstream::before { background: var(--ft-upstream); }
.accent.tone-primary::before { background: var(--ft-primary); }
.label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ft-text-2); }
.value { margin-top: 6px; line-height: 1.2; }
.value b { font-size: 26px; font-weight: 600; }
.unit { margin-left: 6px; font-size: 13px; color: var(--ft-text-2); }
.tone-late .value b { color: var(--ft-late); }
.sub { margin-top: 6px; font-size: 12px; color: var(--ft-text-3); }
</style>
