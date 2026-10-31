<script setup lang="ts">
/**
 * 手机端卡片：白底圆角细边框 + 状态图标（形状也区分状态，不只靠颜色）。设计规范定稿后去掉了左侧色条、阴影。
 *   tone：late 红 / risk 黄 / upstream 受上游影响 / done 绿 / none 灰 / primary 主色；
 *   label：图标旁的状态文字（可空，空时卡片里应另有状态标签）；
 *   link：右侧显示箭头，整张卡片可点（点击事件由父组件 @click 处理）。
 */
import { TONE_ICON, type Tone } from '#shared/mobile-todo'

const props = withDefaults(defineProps<{ tone?: Tone; label?: string; link?: boolean; icon?: boolean }>(), { tone: 'none', label: '', link: false, icon: true })
const emit = defineEmits<{ click: [MouseEvent | KeyboardEvent] }>()
const kind = computed(() => TONE_ICON[props.tone])
function onKey(e: KeyboardEvent) {
  if (!props.link) return
  e.preventDefault()
  emit('click', e)
}
</script>

<template>
  <div
    :class="['m-card', `tone-${tone}`, { link }]"
    :role="link ? 'button' : undefined"
    :tabindex="link ? 0 : undefined"
    @click="emit('click', $event)"
    @keydown.enter="onKey"
    @keydown.space="onKey"
  >
    <div v-if="icon || label" class="m-card-status">
      <UiStatusIcon :kind="kind" :tone="tone" :size="14" />
      <span v-if="label" :class="`m-text-${tone}`">{{ label }}</span>
    </div>
    <div class="m-card-body"><slot /></div>
    <van-icon v-if="link" name="arrow" class="m-card-arrow" />
  </div>
</template>

<style scoped>
.m-card {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  background: var(--card-surface-sheen);
  background-clip: padding-box;
  border: 1px solid var(--card-hairline);
  border-color: var(--card-hairline-top) var(--card-hairline) var(--card-hairline-bottom);
  border-radius: var(--ft-card-radius);
  box-shadow: var(--card-shadow);
  overflow: hidden;
  min-width: 0;
}
.link { cursor: pointer; }
.link:active { background: var(--ft-fill); }
.link:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; }
.m-card-status { flex: none; display: flex; flex-direction: column; align-items: center; gap: 2px; padding-top: 2px; font-size: 11px; line-height: 1.2; }
.m-card-body { flex: 1; min-width: 0; }
.m-card-arrow { flex: none; align-self: center; color: var(--ft-text-3); }
</style>
