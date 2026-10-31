<script setup lang="ts">
/**
 * 通用分区容器（Linear / Stripe 风格）：
 * - 默认（flat = false）：单层纯白卡片，用于承载表格、图表、平铺列表（去掉双层托盘壳）。
 * - 去框化（flat = true）：用于内部已经是独立卡片的大区块（如项目日历、待办流、风险流），
 *   标题直接落在 var(--card-canvas-bg) 冷白画布上，彻底杜绝“卡片套卡片”。
 */
withDefaults(
  defineProps<{ title?: string; sub?: string; padding?: 'normal' | 'tight' | 'none'; flat?: boolean }>(),
  { title: undefined, sub: undefined, padding: 'normal', flat: false },
)
</script>

<template>
  <section class="ft-section" :class="[{ flat, headless: !(title || $slots.title || $slots.extra) }]">
    <header v-if="title || $slots.title || $slots.extra" class="head">
      <div class="titles">
        <h2 v-if="title || $slots.title" class="title"><slot name="title">{{ title }}</slot></h2>
        <div v-if="sub" class="sub">{{ sub }}</div>
      </div>
      <div v-if="$slots.extra" class="extra"><slot name="extra" /></div>
    </header>
    <div class="ft-section-panel" :class="`pad-${padding}`"><slot /></div>
  </section>
</template>

<style scoped>
.ft-section {
  background: var(--ft-card-bg);
  border: 1px solid var(--ft-border);
  border-radius: var(--ft-card-radius);
  box-shadow: var(--ft-card-shadow);
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ft-section-panel { flex: 1; min-width: 0; }
.ft-section-panel.pad-normal { padding: 16px 20px 20px; }
.ft-section-panel.pad-tight { padding: 12px 18px 16px; }
.ft-section-panel.pad-none { padding: 0; overflow: hidden; }
.ft-section:not(.headless) .ft-section-panel.pad-normal { padding-top: 6px; }
.ft-section:not(.headless) .ft-section-panel.pad-tight { padding-top: 4px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 16px 20px 10px; }
.titles { min-width: 0; }
.title { margin: 0; font-size: 15px; font-weight: 600; color: var(--ft-text); line-height: 22px; }
.sub { margin-top: 2px; font-size: 12px; color: var(--ft-text-2); }
.extra { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* 去框化模式：标题直接落在画布上，内部独立单层卡片不再包外框 */
.ft-section.flat {
  background: transparent;
  border: none;
  border-radius: 0;
  box-shadow: none;
}
.ft-section.flat > .head { padding: 4px 2px 12px; }
.ft-section.flat > .head .title { font-size: 16px; }
.ft-section.flat > .ft-section-panel { padding: 0; }

@media (max-width: 575px) {
  .head { padding: 14px 16px 8px; }
  .ft-section-panel.pad-normal { padding: 12px 16px 16px; }
}
</style>
