<script setup lang="ts">
/**
 * 通用分区容器（Linear / Ember 风格）：
 * - 默认（flat = false）：单层纯白卡片，用于承载表格、图表、Payouts 式去框平铺列表。
 *   可选 icon 属性在标题左侧渲染 24×24 白底细描边圆角图标块。
 * - 去框化（flat = true）：用于内部已经是独立卡片的大区块（如项目日历、总览工单卡网格），
 *   标题直接落在工作台画板上，彻底杜绝“卡片套卡片”。
 */
withDefaults(
  defineProps<{
    title?: string
    sub?: string
    padding?: 'normal' | 'tight' | 'none'
    flat?: boolean
    icon?: 'inbox' | 'shield' | 'bars' | 'chart' | 'list'
  }>(),
  { title: undefined, sub: undefined, padding: 'normal', flat: false, icon: undefined },
)
</script>

<template>
  <section class="ft-section" :class="[{ flat, headless: !(title || $slots.title || $slots.extra) }]">
    <header v-if="title || $slots.title || $slots.extra" class="head">
      <div class="titles">
        <div v-if="title || $slots.title" class="title-line">
          <span v-if="icon" class="head-ico" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <template v-if="icon === 'inbox'">
                <path d="M2.3 8.6 4 3.4h8l1.7 5.2v3.6a1 1 0 0 1-1 1H3.3a1 1 0 0 1-1-1V8.6Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
                <path d="M2.5 8.8h3.2a2.3 2.3 0 0 0 4.6 0h3.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
              </template>
              <template v-else-if="icon === 'shield'">
                <path d="M8 2.1 13 4v3.8c0 3.1-2.1 5.2-5 6.2-2.9-1-5-3.1-5-6.2V4l5-1.9Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
                <path d="M8 5.6v3M8 10.8h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </template>
              <template v-else-if="icon === 'bars'">
                <path d="M3 4.5h10M3 8h7M3 11.5h4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </template>
              <template v-else-if="icon === 'chart'">
                <path d="M3 12.5V8.5M6.5 12.5V5.5M10 12.5V7M13 12.5V3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </template>
              <template v-else>
                <rect x="2.5" y="3" width="11" height="10" rx="2" stroke="currentColor" stroke-width="1.4" />
                <path d="M5.2 6.5h5.6M5.2 9.5h3.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              </template>
            </svg>
          </span>
          <h2 class="title"><slot name="title">{{ title }}</slot></h2>
        </div>
        <div v-if="sub" class="sub">{{ sub }}</div>
      </div>
      <div v-if="$slots.extra" class="extra"><slot name="extra" /></div>
    </header>
    <div class="ft-section-panel" :class="`pad-${padding}`"><slot /></div>
  </section>
</template>

<style scoped>
.ft-section {
  background: var(--card-surface-sheen);
  background-clip: padding-box;
  border: 1px solid var(--card-hairline);
  border-color: var(--card-hairline-top) var(--card-hairline) var(--card-hairline-bottom);
  border-radius: var(--ft-card-radius);
  box-shadow: var(--ft-card-shadow);
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ft-section-panel { flex: 1; min-width: 0; }
.ft-section-panel.pad-normal { padding: 16px 20px 20px; }
.ft-section-panel.pad-tight { padding: 12px 18px 16px; }
.ft-section-panel.pad-none { padding: 0; overflow: hidden; border-radius: 0 0 calc(var(--ft-card-radius) - 1px) calc(var(--ft-card-radius) - 1px); }
.ft-section:not(.headless) .ft-section-panel.pad-normal { padding-top: 6px; }
.ft-section:not(.headless) .ft-section-panel.pad-tight { padding-top: 4px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 15px 20px 11px; }
.titles { min-width: 0; }
.title-line { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.head-ico {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: var(--card-keycap-surface);
  background-clip: padding-box;
  border: 1px solid var(--card-hairline);
  border-color: var(--card-hairline-top) var(--card-hairline) var(--card-hairline-bottom);
  box-shadow: var(--card-keycap-shadow);
  color: var(--ft-text-2);
}
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
