<script setup lang="ts">
/**
 * 加工中：已开工、还没完工的自制 / 厂内外协工序，在手机上点"完工"（借鉴 ERPNext 作业卡的开工 → 完工按钮流，10-26）。
 * 默认看自己负责的，可切到全部；从 W10 逾期提醒跳过来时带 ?stepId=，切到全部并把那道排在最前。
 * 能否点完工与电脑端一致：生产部、外协专员、该工序责任人、管理员（后端同样拦）。
 */
definePageMeta({ layout: 'mobile' })
const { data: me } = await useMe()
const route = useRoute()
const focusId = (route.query.stepId as string) || ''
const tab = ref<'mine' | 'all'>(focusId ? 'all' : 'mine')
const { data: rows, pending, refresh } = await useFetch('/api/working', {
  query: computed(() => ({ mine: tab.value === 'mine' ? '1' : '0' })),
  default: () => [],
})
type Row = (typeof rows.value)[number]
const list = computed(() => (focusId ? [...rows.value].sort((a, b) => Number(b.stepId === focusId) - Number(a.stepId === focusId)) : rows.value))

async function finish(r: Row) {
  try {
    await showConfirmDialog({ title: '确认完工', message: `${r.partName} · ${r.processName}（${r.quantity} 件）\n完工后自动给下一道工序发待办` })
  } catch {
    return // 取消
  }
  try {
    await $fetch(`/api/steps/${r.stepId}/finish`, { method: 'POST', body: { source: 'MOBILE' } })
    showSuccessToast('已完工')
    await Promise.all([refresh(), refreshNuxtData('todos')])
  } catch (e) {
    showFailToast(apiError(e))
  }
}
const dueText = (r: Row) => (r.dueDate ? `要求 ${dayText(r.dueDate)} 完工` : '未定要求完成日')
</script>

<template>
  <div>
    <van-nav-bar title="加工中" />
    <van-tabs v-model:active="tab" shrink>
      <van-tab title="我负责的" name="mine" />
      <van-tab title="全部" name="all" />
    </van-tabs>
    <van-loading v-if="pending" class="m-center" />
    <van-empty v-else-if="!list.length" description="没有加工中的工序" image-size="80" />
    <div v-else class="m-list">
      <MCard v-for="r in list" :key="r.stepId" :tone="r.overdueDays > 0 ? 'late' : 'primary'" :class="{ focus: r.stepId === focusId }">
        <div class="m-row">
          <van-tag v-if="r.overdueDays > 0" type="danger">已超期 {{ r.overdueDays }} 天</van-tag>
          <van-tag v-else type="primary">加工中</van-tag>
          <span class="wo">{{ r.workOrderNumber }}</span>
        </div>
        <div class="m-title name">{{ r.partName }} · {{ r.processName }}</div>
        <div class="m-meta">
          <span>{{ r.mode === 'IN_PLANT_OUTSOURCE' ? (r.supplierName ?? '厂内外协') : '自制' }} · {{ r.quantity }} 件</span>
          <span :class="{ 'm-text-late': r.overdueDays > 0 }">{{ dueText(r) }}</span>
        </div>
        <div class="m-meta">
          <span>负责人 {{ r.ownerName ?? '—' }}</span>
          <span>开工 {{ dayText(r.startedAt) || '—' }}</span>
        </div>
        <div v-if="canDo(me, 'stepAction', { workOrderNumber: r.workOrderNumber, ownerId: r.ownerId })" class="m-foot-row">
          <span class="m-spacer" />
          <van-button size="small" type="primary" @click="finish(r)">完工</van-button>
        </div>
      </MCard>
    </div>
    <div class="m-foot" />
  </div>
</template>

<style scoped>
.wo { font-size: 13px; color: var(--ft-text-2); font-weight: 500; }
.name { margin-top: 6px; }
.focus { border-color: var(--ft-primary); }
</style>
