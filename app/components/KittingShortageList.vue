<script setup lang="ts">
/** 手机端一个节点的缺件列表（R12，只读）：每个缺件卡在哪一步；物料带承诺日、需求日、是否逾期 */
defineProps<{ node: KitNode }>()
</script>

<template>
  <div class="kit">
    <div class="muted">{{ node.total ? `已就绪 ${node.ready} / 应有 ${node.total}` : '清单为空' }}　负责人 {{ node.ownerText }}</div>
    <div v-for="s in node.shortages" :key="`${s.kind}:${s.id}`" class="row">
      <div>
        <van-tag plain :type="s.kind === 'part' ? 'primary' : 'warning'" class="tag">{{ s.kind === 'part' ? '工件' : '物料' }}</van-tag>
        <span class="name">{{ s.name }}</span>
      </div>
      <div class="desc">
        <template v-if="s.kind === 'part'">{{ s.stage ? `${s.stage} · ` : '' }}<b>{{ s.reason }}</b>{{ s.detail ? `（${s.detail}）` : '' }}</template>
        <template v-else>
          <b>{{ s.stage }}</b>　承诺 {{ s.promisedDate ?? '无' }} / 需求 {{ s.needDate }}
          <span v-if="s.overdue" class="warn">　逾期</span>
          <span v-if="s.lateForNode" class="warn">　赶不上节点</span>
        </template>
      </div>
    </div>
    <div v-if="node.readyItems.length" class="muted ready">已就绪：{{ node.readyItems.join('、') }}</div>
  </div>
</template>

<style scoped>
.kit { font-size: 13px; }
.row { padding: 6px 0; border-bottom: 1px solid #f2f3f5; }
.tag { margin-right: 6px; }
.name { color: #323233; }
.desc { color: #646566; margin-top: 2px; }
.warn { color: #ee0a24; }
.muted { color: #969799; font-size: 12px; }
.ready { margin-top: 6px; }
</style>
