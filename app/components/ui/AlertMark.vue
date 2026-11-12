<script setup lang="ts">
/**
 * 线性微预警图标（Brick 风格，全局复用）：
 * 替代厚重的彩色胶囊底块，用 14px 菱形感叹号（late 延误/逾期）或圆角方框感叹号（risk 临期/待确认）表达状态。
 */
defineProps<{
  level?: 'late' | 'risk' | null
  title?: string
}>()
</script>

<template>
  <span
    v-if="level === 'late'"
    class="ft-alert-mark is-late"
    :title="title || '已逾期 / 延误'"
    aria-hidden="true"
  >
    <span>!</span>
  </span>
  <span
    v-else-if="level === 'risk'"
    class="ft-alert-mark is-risk"
    :title="title || '临期 / 待确认'"
    aria-hidden="true"
  >
    !
  </span>
</template>

<style scoped>
.ft-alert-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  font-size: 9.5px;
  font-weight: 700;
  line-height: 1;
  flex-shrink: 0;
  vertical-align: middle;
}
.ft-alert-mark.is-late {
  border: 1.4px solid var(--ft-late);
  color: var(--ft-late);
  border-radius: 3px;
  transform: rotate(45deg);
}
.ft-alert-mark.is-late > span {
  transform: rotate(-45deg);
  line-height: 1;
}
.ft-alert-mark.is-risk {
  border: 1.4px solid var(--ft-risk-text);
  color: var(--ft-risk-text);
  border-radius: 3px;
}
</style>
