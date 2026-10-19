<script setup lang="ts">
/** 手机端一个节点的缺件列表（R12，只读）：每个缺件卡在哪一步；物料带承诺日、需求日、是否逾期。齐套率、负责人在外面的卡片上（components/m/KitCard） */
defineProps<{ node: KitNode }>()
</script>

<template>
  <div class="kit">
    <div v-for="s in node.shortages" :key="`${s.kind}:${s.id}`" class="row">
      <div class="head">
        <van-tag plain :type="s.kind === 'part' ? 'primary' : 'warning'">{{ s.kind === 'part' ? '工件' : '物料' }}</van-tag>
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
    <div v-if="node.readyItems.length" class="ready"><UiStatusIcon kind="check" :size="12" /> 已就绪：{{ node.readyItems.join('、') }}</div>
  </div>
</template>

<style scoped>
.kit { font-size: 13px; }
.row { padding: 8px 10px; margin-bottom: 6px; border-radius: 10px; background: var(--ft-fill); }
.head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.name { color: var(--ft-text); font-weight: 500; overflow-wrap: anywhere; min-width: 0; }
.desc { color: var(--ft-text-2); margin-top: 4px; line-height: 18px; overflow-wrap: anywhere; }
.warn { color: var(--ft-late-text); font-weight: 600; white-space: nowrap; }
.ready { margin-top: 4px; color: var(--ft-done-text); font-size: 12px; line-height: 18px; }
</style>
