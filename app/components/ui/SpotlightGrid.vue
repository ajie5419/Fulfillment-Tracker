<script setup lang="ts">
/**
 * 顶部双栏「焦点迷你清单卡」（Brick 风格，全局复用）：
 * 左卡展示「今日与近期启动 / 本周到期」，右卡展示「需要关注 / 临期与逾期」，
 * 无需二次点击筛选即可直接看到前几条关键任务的名称、所属工单、责任人微头像与状态原因。
 */
export interface SpotlightItem {
  id: string
  title: string
  meta?: string
  ownerName?: string | null
  rightText: string
  level?: 'late' | 'risk' | null
}

withDefaults(
  defineProps<{
    leftTitle: string
    leftCount?: number | string | null
    leftItems: SpotlightItem[]
    leftEmpty?: string
    leftActive?: boolean
    rightTitle: string
    rightCount?: number | string | null
    rightItems: SpotlightItem[]
    rightEmpty?: string
    rightActive?: boolean
  }>(),
  {
    leftCount: null,
    leftEmpty: '暂无近期到期或启动项',
    leftActive: false,
    rightCount: null,
    rightEmpty: '当前无逾期或预警项',
    rightActive: false,
  },
)

const emit = defineEmits<{
  clickLeftHead: []
  clickRightHead: []
  select: [item: SpotlightItem]
}>()
</script>

<template>
  <div class="ft-spotlight-grid">
    <!-- 左卡：近期启动 / 本周到期 -->
    <div class="sp-card" :class="{ 'is-active': leftActive }">
      <button type="button" class="sp-head" @click="emit('clickLeftHead')">
        <span class="sp-title">{{ leftTitle }}</span>
        <span class="sp-count">{{ leftCount ?? leftItems.length }}</span>
      </button>

      <div v-if="!leftItems.length" class="sp-empty">
        {{ leftEmpty }}
      </div>
      <div v-else class="sp-list">
        <button
          v-for="it in leftItems"
          :key="it.id"
          type="button"
          class="sp-row"
          @click="emit('select', it)"
        >
          <div class="sp-left">
            <UiUserChip :name="it.ownerName" />
            <span class="sp-name">{{ it.title }}</span>
            <span v-if="it.meta" class="sp-meta">{{ it.meta }}</span>
          </div>
          <div class="sp-right">
            <UiAlertMark v-if="it.level" :level="it.level" />
            <span>{{ it.rightText }}</span>
          </div>
        </button>
      </div>
    </div>

    <!-- 右卡：需要关注 / 临期与逾期 -->
    <div class="sp-card" :class="{ 'is-active': rightActive }">
      <button type="button" class="sp-head" @click="emit('clickRightHead')">
        <span class="sp-title">{{ rightTitle }}</span>
        <span class="sp-count">{{ rightCount ?? rightItems.length }}</span>
      </button>

      <div v-if="!rightItems.length" class="sp-empty">
        {{ rightEmpty }}
      </div>
      <div v-else class="sp-list">
        <button
          v-for="it in rightItems"
          :key="it.id"
          type="button"
          class="sp-row"
          @click="emit('select', it)"
        >
          <div class="sp-left">
            <UiUserChip :name="it.ownerName" />
            <span class="sp-name">{{ it.title }}</span>
            <span v-if="it.meta" class="sp-meta">{{ it.meta }}</span>
          </div>
          <div class="sp-right">
            <UiAlertMark v-if="it.level" :level="it.level" />
            <span :class="{ 'text-late': it.level === 'late', 'text-risk': it.level === 'risk' }">{{ it.rightText }}</span>
          </div>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ft-spotlight-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  font-variant-numeric: tabular-nums;
}

.sp-card {
  background: var(--ft-card-bg);
  border: 1px solid var(--ft-border);
  border-radius: 12px;
  padding: 12px 16px 6px;
  box-shadow: var(--ft-card-shadow);
  display: flex;
  flex-direction: column;
  min-width: 0;
  transition: border-color 0.15s ease;
}

.sp-card.is-active {
  border-color: var(--ft-primary);
}

.sp-head {
  padding: 0 0 8px;
  border: 0;
  background: none;
  font: inherit;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  text-align: left;
  align-self: flex-start;
}

.sp-head:hover .sp-title {
  color: var(--ft-text);
}

.sp-title {
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--ft-text-3);
}

.sp-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--ft-tray-bg);
  color: var(--ft-text-2);
  font-size: 11px;
  font-weight: 600;
}

.sp-empty {
  padding: 14px 0 18px;
  color: var(--ft-text-3);
  font-size: 12.5px;
  border-top: 1px solid var(--card-border-subtle);
}

.sp-list {
  display: flex;
  flex-direction: column;
}

.sp-row {
  width: 100%;
  padding: 7px 0;
  border: 0;
  border-top: 1px solid var(--card-border-subtle);
  background: none;
  font: inherit;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}

.sp-row:hover .sp-name {
  color: var(--ft-primary);
}

.sp-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.sp-left :deep(.ft-user-chip .name) {
  display: none;
}

.sp-name {
  font-weight: 500;
  color: var(--ft-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sp-meta {
  color: var(--ft-text-3);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sp-right {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  font-size: 12px;
  color: var(--ft-text-2);
  flex-shrink: 0;
}

.text-late {
  color: var(--ft-late-text);
}

.text-risk {
  color: var(--ft-risk-text);
}

@media (max-width: 900px) {
  .ft-spotlight-grid {
    grid-template-columns: 1fr;
  }
}
</style>
