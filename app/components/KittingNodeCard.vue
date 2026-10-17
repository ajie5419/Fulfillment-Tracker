<script setup lang="ts">
/** 齐套页的一个装配节点卡片：齐套率进度条 + 缺件表（R12）。工单视图和"提醒的节点"共用 */
const props = defineProps<{ node: KitNode; focus?: boolean; windowDays: number }>()
defineEmits<{ edit: [node: KitNode]; remove: [node: KitNode] }>()
const n = computed(() => props.node)
</script>

<template>
  <a-card :id="`node-${n.id}`" size="small" class="node" :class="{ focus }">
    <template #title>
      <span class="node-name">{{ n.name }}</span>
      <a-tag v-if="n.alertLevel === 'RED'" color="red">红</a-tag>
      <a-tag v-else-if="n.alertLevel === 'YELLOW'" color="orange">黄</a-tag>
      <span class="muted">　{{ n.workOrderNumber }}　需求日 {{ dayText(n.needDate) }}（<span :class="{ warn: n.incomplete && n.daysLeft <= windowDays }">{{ daysLeftText(n.daysLeft) }}</span>）　负责人 {{ n.ownerText }}</span>
    </template>
    <template #extra>
      <a-space v-if="n.canEdit" size="small">
        <a-button size="small" @click="$emit('edit', n)">编辑</a-button>
        <a-button size="small" danger @click="$emit('remove', n)">删除</a-button>
      </a-space>
    </template>
    <div class="progress">
      <a-progress v-if="n.percent != null" :percent="n.percent" :status="kitProgressStatus(n)" />
      <span v-else class="muted">清单为空：编辑节点选择需要的工件和关键物料</span>
      <span v-if="n.total" class="muted count">已就绪 {{ n.ready }} / 应有 {{ n.total }}</span>
    </div>
    <KittingShortageTable v-if="n.shortages.length" :shortages="n.shortages" />
    <div v-if="n.readyItems.length" class="muted ready">已就绪：{{ n.readyItems.join('、') }}</div>
    <div v-if="n.excluded.length" class="muted">已取消、不计入：{{ n.excluded.join('、') }}</div>
    <div v-if="n.note" class="muted">备注：{{ n.note }}</div>
  </a-card>
</template>

<style scoped>
.muted { color: #999; font-size: 12px; }
.warn { color: #cf1322; }
.node { margin-bottom: 12px; }
.node.focus { border-color: #1677ff; box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.2); }
.node-name { font-weight: 600; margin-right: 6px; }
.progress { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.progress :deep(.ant-progress) { flex: 1; max-width: 480px; margin: 0; }
.count { white-space: nowrap; }
.ready { margin-top: 6px; }
</style>
