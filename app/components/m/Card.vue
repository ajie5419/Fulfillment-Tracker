<script setup lang="ts">
/**
 * 手机端卡片（前端改版第二轮）：白底圆角，左侧状态色条 + 状态图标（形状也区分状态，不只靠颜色）。
 *   tone：late 红 / risk 黄 / upstream 受上游影响 / done 绿 / none 灰 / primary 主色；
 *   label：图标旁的状态文字（可空，空时只在色条上体现，卡片里应另有状态标签）；
 *   link：右侧显示箭头，整张卡片可点（点击事件由父组件 @click 处理）。
 */
import { TONE_ICON, type Tone } from '#shared/mobile-todo'

const props = withDefaults(defineProps<{ tone?: Tone; label?: string; link?: boolean; icon?: boolean }>(), { tone: 'none', label: '', link: false, icon: true })
defineEmits<{ click: [MouseEvent] }>()
const kind = computed(() => TONE_ICON[props.tone])
</script>

<template>
  <div :class="['m-card', `tone-${tone}`, { link }]" :role="link ? 'button' : undefined" @click="$emit('click', $event)">
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
  padding: 12px 14px 12px 16px;
  background: var(--ft-card-bg);
  border-radius: var(--ft-card-radius);
  box-shadow: var(--ft-card-shadow);
  overflow: hidden;
  min-width: 0;
}
/* 左侧状态色条 */
.m-card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--bar); }
.tone-late { --bar: var(--ft-late); }
.tone-risk { --bar: var(--ft-risk); }
.tone-upstream { --bar: var(--ft-upstream); }
.tone-done { --bar: var(--ft-done); }
.tone-none { --bar: var(--ft-none); }
.tone-primary { --bar: var(--ft-primary); }
.link { cursor: pointer; }
.link:active { background: var(--ft-fill); }
.m-card-status { flex: none; display: flex; flex-direction: column; align-items: center; gap: 2px; padding-top: 2px; font-size: 11px; line-height: 1.2; }
.m-card-body { flex: 1; min-width: 0; }
.m-card-arrow { flex: none; align-self: center; color: var(--ft-text-3); }
</style>
