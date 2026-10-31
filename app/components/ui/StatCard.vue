<script setup lang="ts">
/**
 * 统计卡（前端改版第一轮）：标签 + 大数字（+ 单位）+ 补充说明（#sub 或 sub）。
 * tone 决定顶部色条和图标颜色（late 延误红 / risk 有风险黄 / done 正常绿 / upstream 受上游影响橙 / none 灰 / primary 主色）；
 * 状态永远带文字（label），颜色只是辅助。给了 to 时整张卡可点击；
 * 第二轮：clickable 时整张卡是按钮（点了在本页套用筛选，触发 click），键盘回车 / 空格也能点。
 * 设计改版试点：chip 时顶部一行"圆形浅底图标 + 标签"，下面大数字（统一深色，状态靠图标形状、颜色和标签文字表达），不显示顶部色条；
 * 图标默认按 tone 选。不传 chip 时外观不变。
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
    /** 原为顶部色条；现在只加细边框（色条已去掉） */
    accent?: boolean
    /** 标签前的状态标记（设计改版后统一画成细色条，颜色按 tone） */
    icon?: 'alert' | 'warn' | 'check' | 'ring' | 'dot' | null
    to?: RouteLocationRaw
    active?: boolean
    clickable?: boolean
    /** 左侧浅底图标块（替代顶部色条） */
    chip?: boolean
  }>(),
  { value: null, unit: undefined, sub: undefined, tone: undefined, accent: false, icon: null, to: undefined, active: false, clickable: false, chip: false },
)
const emit = defineEmits<{ click: [e: MouseEvent | KeyboardEvent] }>()
const tag = computed(() => (props.to ? NuxtLink : 'div'))
const asButton = computed(() => !props.to && props.clickable)
/** 图标形状也区分状态（不只靠颜色），与 UiStatusIcon 的默认对应关系一致 */
const CHIP_ICON = { late: 'alert', risk: 'warn', done: 'check', upstream: 'warn', none: 'ring', primary: 'dot' } as const
const chipIcon = computed(() => props.icon ?? CHIP_ICON[props.tone ?? 'none'])
const headIcon = computed(() => props.chip ? chipIcon.value : (props.icon ?? CHIP_ICON[props.tone ?? 'none']))
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
    :class="[tone ? `tone-${tone}` : '', { accent: accent && !chip, chip, link: !!to || clickable, active }]"
    :role="asButton ? 'button' : undefined"
    :tabindex="asButton ? 0 : undefined"
    :aria-pressed="asButton ? active : undefined"
    @click="emit('click', $event)"
    @keydown.enter="onKey"
    @keydown.space="onKey"
  >
    <div class="ft-stat-head">
      <span class="ft-stat-iconbox"><UiStatusIcon :kind="headIcon" :tone="tone ?? 'none'" :size="15" /></span>
      <span class="ft-stat-label">{{ label }}</span>
    </div>
    <div class="ft-stat-inner">
      <div v-if="value != null || $slots.value" class="value">
        <slot name="value"><b>{{ value }}</b><span v-if="unit" class="unit">{{ unit }}</span></slot>
      </div>
      <div v-if="sub || $slots.sub || $slots.default" class="sub"><slot name="sub">{{ sub }}</slot><slot /></div>
    </div>
  </component>
</template>

<style scoped>
.ft-stat { display: flex; flex-direction: column; position: relative; background: var(--card-tray-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius-outer); box-shadow: none; padding: 0; height: 100%; box-sizing: border-box; color: var(--ft-text); min-width: 0; overflow: hidden; }
.ft-stat-head { display: flex; align-items: center; gap: 9px; padding: 10px 12px 9px; flex: none; }
.ft-stat-iconbox { flex: none; width: 26px; height: 26px; border-radius: 8px; background: var(--card-surface-bg); border: 1px solid var(--card-border-subtle); box-shadow: var(--card-shadow); display: flex; align-items: center; justify-content: center; }
.ft-stat-label { min-width: 0; font-size: 14px; font-weight: 500; color: var(--ft-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ft-stat-inner { margin: 0 var(--card-tray-padding) var(--card-tray-padding); flex: 1; background: var(--card-surface-bg); border: 1px solid var(--card-border-subtle); border-radius: var(--card-radius-inner); box-shadow: var(--card-shadow); box-sizing: border-box; padding: 14px 16px; }
.ft-stat.link { cursor: pointer; }
.ft-stat.link .ft-stat-inner { transition: box-shadow 0.15s; }
.ft-stat.link:hover { color: var(--ft-text); }
.ft-stat.link:hover .ft-stat-inner { box-shadow: 0 2px 4px rgba(16, 24, 40, 0.06), 0 6px 16px rgba(16, 24, 40, 0.08); }
.ft-stat.active { outline: 2px solid var(--ft-primary); }
.ft-stat.link:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; }
/* 设计改版：顶部色条（accent）按用户意见去掉，状态由标签前的图标和文字表达（用到 accent 的卡片都带 icon）；
   改成和 chip 一样的细边框，accent 属性保留以免各页面改调用 */
.accent { border: 1px solid var(--ft-border); }
.value { margin-top: 0; line-height: 1.2; }
.value b { font-size: 28px; font-weight: 600; letter-spacing: -0.5px; }
.unit { margin-left: 6px; font-size: 13px; color: var(--ft-text-2); }
.tone-late .value b { color: var(--ft-late); }
.sub { margin-top: 6px; font-size: 12px; color: var(--ft-text-2); }
/* chip：放在分组大卡片里用，内面板保留更宽的内边距 */
.chip .ft-stat-inner { padding: 16px 18px; }
.chip.link:hover .ft-stat-inner { box-shadow: 0 4px 14px rgba(16, 24, 40, 0.08); border-color: transparent; }
.chip .value b, .chip.tone-late .value b { color: var(--ft-text); }
</style>
