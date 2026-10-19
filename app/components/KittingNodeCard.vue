<script setup lang="ts">
/**
 * 齐套页的一个装配节点卡片：齐套率 + 缺件表（R12）。工单视图和"提醒的节点"共用。
 * 前端改版第二轮：齐套率改成环形进度（Ring，颜色：齐了绿、红色预警红、黄色预警黄、其余主色），旁边是缺件按原因的计数标签。
 */
import { shortageReasonCounts } from '#shared/workbench'

// linkable=false：工单不在查看人可见范围（"提醒的节点"单独展示时），工单号和节点只显示文字，不链到会 403 的工单详情
const props = withDefaults(defineProps<{ node: KitNode; focus?: boolean; windowDays: number; linkable?: boolean }>(), { linkable: true })
defineEmits<{ edit: [node: KitNode]; remove: [node: KitNode] }>()
const n = computed(() => props.node)
const reasons = computed(() => shortageReasonCounts(n.value.shortages))
const ringColor = computed(() => {
  const st = kitProgressStatus(n.value)
  if (st === 'success') return 'var(--ft-done)'
  if (st === 'exception') return 'var(--ft-late)'
  return n.value.alertLevel === 'YELLOW' ? 'var(--ft-risk)' : 'var(--ft-primary)'
})
</script>

<template>
  <a-card :id="`node-${n.id}`" size="small" class="node" :class="{ focus }">
    <template #title>
      <span class="node-name">{{ n.name }}</span>
      <a-tag v-if="n.alertLevel === 'RED'" color="red">红</a-tag>
      <a-tag v-else-if="n.alertLevel === 'YELLOW'" color="orange">黄</a-tag>
      <span class="muted">　<WoLink v-if="linkable" :no="n.workOrderNumber" /><template v-else>{{ n.workOrderNumber }}</template>　总计划节点 <PlanNodeCell v-if="linkable" :work-order-number="n.workOrderNumber" :node="n.planNode" /><template v-else>{{ n.planNode ? `${n.planNode.seq}. ${n.planNode.name}` : '未挂节点' }}</template>　需求日 {{ dayText(n.needDate) }}（<span :class="{ warn: n.incomplete && n.daysLeft <= windowDays }">{{ daysLeftText(n.daysLeft) }}</span>）　负责人 {{ n.ownerText }}</span>
    </template>
    <template #extra>
      <a-space v-if="n.canEdit" size="small">
        <a-button size="small" @click="$emit('edit', n)">编辑</a-button>
        <a-button size="small" danger @click="$emit('remove', n)">删除</a-button>
      </a-space>
    </template>
    <div class="progress">
      <template v-if="n.percent != null">
        <UiRing :value="n.ready" :total="n.total" :size="72" :stroke="8" :color="ringColor" :label="`${n.percent}%`" />
        <div class="summary">
          <div class="count">已就绪 <b>{{ n.ready }}</b> / 应有 {{ n.total }}<template v-if="n.shortages.length">，缺 <b class="warn">{{ n.shortages.length }}</b> 项</template></div>
          <div v-if="reasons.length" class="reasons">
            <a-tag v-for="r in reasons" :key="r.reason" :color="BLOCKER_COLOR[r.code] ?? 'default'" class="reason">{{ r.reason }} {{ r.count }}</a-tag>
          </div>
          <div v-else class="muted">不缺件</div>
        </div>
      </template>
      <span v-else class="muted">清单为空：编辑节点选择需要的工件和关键物料</span>
    </div>
    <KittingShortageTable v-if="n.shortages.length" :shortages="n.shortages" />
    <div v-if="n.readyItems.length" class="muted ready">已就绪：{{ n.readyItems.join('、') }}</div>
    <div v-if="n.excluded.length" class="muted">已取消、不计入：{{ n.excluded.join('、') }}</div>
    <div v-if="n.note" class="muted">备注：{{ n.note }}</div>
  </a-card>
</template>

<style scoped>
.muted { color: #999; font-size: 12px; }
.warn { color: var(--ft-late-text); }
.node { margin-bottom: 12px; }
.node.focus { border-color: var(--ft-primary); box-shadow: 0 0 0 2px rgba(42, 120, 214, 0.2); }
.node-name { font-weight: 600; margin-right: 6px; }
.progress { display: flex; align-items: center; gap: 16px; margin-bottom: 10px; }
.progress :deep(.txt) { font-size: 14px; }
.summary { min-width: 0; }
.count { color: var(--ft-text-2); font-size: 13px; }
.count b { color: var(--ft-text); }
.count b.warn { color: var(--ft-late-text); }
.reasons { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.reason { margin: 0; }
.ready { margin-top: 6px; }
</style>
