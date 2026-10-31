<script setup lang="ts">
/**
 * 页面顶部导览头（Ember Editorial Hero）：
 * 左侧大号主标题 + 一句话实时业务数据摘要（带微星标点缀），右侧紧凑操作按钮组。
 * 摘要必须由真实接口数据计算生成，严禁编写虚构环比或假数据。
 */
withDefaults(
  defineProps<{
    title: string
    summary?: string
    spark?: boolean
  }>(),
  { summary: undefined, spark: true },
)
</script>

<template>
  <header class="ft-hero">
    <div class="ft-hero-main">
      <div class="ft-hero-title-row">
        <h2 class="ft-hero-title">{{ title }}</h2>
        <slot name="titleAfter" />
      </div>
      <p v-if="summary || $slots.summary" class="ft-hero-sub">
        <slot name="summary">{{ summary }}</slot>
        <svg v-if="spark" class="ft-hero-spark" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 1.8c.45 2.9 1.8 4.25 4.7 4.7-2.9.45-4.25 1.8-4.7 4.7-.45-2.9-1.8-4.25-4.7-4.7 2.9-.45 4.25-1.8 4.7-4.7Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
          <path d="M12.6 10.6c.2 1.15.75 1.7 1.9 1.9-1.15.2-1.7.75-1.9 1.9-.2-1.15-.75-1.7-1.9-1.9 1.15-.2 1.7-.75 1.9-1.9Z" fill="currentColor" />
        </svg>
      </p>
    </div>
    <div v-if="$slots.actions" class="ft-hero-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.ft-hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px 20px;
  flex-wrap: wrap;
  padding: 2px 0 2px;
}
.ft-hero-main { min-width: 0; flex: 1 1 320px; }
.ft-hero-title-row { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.ft-hero-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.025em;
  line-height: 1.25;
  color: var(--ft-text);
}
.ft-hero-sub {
  margin: 5px 0 0;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--ft-text-2);
}
.ft-hero-spark {
  display: inline-block;
  margin-left: 5px;
  vertical-align: -2px;
  color: var(--ft-upstream);
}
.ft-hero-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
@media (max-width: 575px) {
  .ft-hero-title { font-size: 19px; }
}
</style>
