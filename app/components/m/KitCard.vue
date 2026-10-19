<script setup lang="ts">
/**
 * 手机齐套页的一个装配节点卡片（R12，只读；前端改版第二轮）：状态色条、齐套率进度条、缺件原因标签，展开看缺件明细。
 *   windowDays：W8 预警窗口（需求日前几天内未齐套的"剩余天数"标红）；
 *   open：是否展开缺件明细；fixed 时一直展开、不显示展开按钮（提醒点进来的节点）。
 */
import { kitTone, shortageReasonTags } from '#shared/mobile-kitting'

const props = defineProps<{ node: KitNode; windowDays: number; open: boolean; fixed?: boolean }>()
defineEmits<{ toggle: [] }>()
const tone = computed(() => kitTone(props.node))
const reasons = computed(() => shortageReasonTags(props.node.shortages))
const tagType = computed(() => (props.node.alertLevel === 'RED' ? 'danger' : props.node.alertLevel === 'YELLOW' ? 'warning' : props.node.incomplete ? 'primary' : 'success'))
const stateText = computed(() => (props.node.percent == null ? '清单空' : props.node.incomplete ? '未齐套' : '已齐套'))
</script>

<template>
  <MCard :tone="tone">
    <div class="m-row">
      <van-tag :type="node.percent == null ? 'default' : tagType">{{ stateText }}</van-tag>
      <span class="wo">{{ node.workOrderNumber }}</span>
    </div>
    <div class="m-title name">{{ node.name }}</div>
    <div class="m-meta">
      <span>需求日 {{ dayText(node.needDate) }}</span>
      <span :class="{ 'm-text-late': node.incomplete && node.daysLeft <= windowDays }">{{ daysLeftText(node.daysLeft) }}</span>
      <span>负责人 {{ node.ownerText }}</span>
    </div>
    <div class="m-progress">
      <van-progress :percentage="node.percent ?? 0" :show-pivot="false" :class="`m-progress-${tone}`" />
      <span :class="['m-progress-text', `m-text-${tone}`]">{{ node.percent == null ? '清单为空' : `齐套 ${node.percent}%` }}</span>
    </div>
    <div v-if="node.total" class="count m-muted">已就绪 {{ node.ready }} / 应有 {{ node.total }}</div>
    <div v-if="reasons.length" class="reasons">
      <span class="reasons-label">缺件原因</span>
      <van-tag v-for="r in reasons" :key="r.text" :type="r.type" plain>{{ r.text }}{{ r.count > 1 ? ` ×${r.count}` : '' }}</van-tag>
    </div>
    <template v-if="node.shortages.length || node.readyItems.length">
      <div v-if="!fixed" class="toggle" role="button" @click="$emit('toggle')">
        {{ open ? '收起明细' : `查看明细${node.shortages.length ? `（缺 ${node.shortages.length} 项）` : ''}` }}
        <van-icon :name="open ? 'arrow-up' : 'arrow-down'" />
      </div>
      <div v-if="open || fixed" class="detail"><KittingShortageList :node="node" /></div>
    </template>
  </MCard>
</template>

<style scoped>
.wo { font-size: 13px; color: var(--ft-text-2); font-weight: 500; }
.name { margin-top: 6px; }
.count { margin-top: 4px; font-size: 12px; }
.reasons { margin-top: 10px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.reasons-label { font-size: 12px; color: var(--ft-text-2); }
.toggle { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--ft-border); font-size: 13px; color: var(--ft-primary); display: flex; align-items: center; justify-content: center; gap: 4px; cursor: pointer; }
.detail { margin-top: 8px; }
</style>
