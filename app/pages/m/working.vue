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

// ───── 完工弹窗：默认剩余全部；数量不够时选"剩下的还在做"（部分完工）或"报废了"（自动转异常，生产经理安排补料）─────
const finishing = ref<Row | null>(null)
const finishQty = ref(0)
const rest = ref<'CONTINUE' | 'SCRAP'>('CONTINUE')
const scrapNote = ref('')
const saving = ref(false)
const remainingOf = (r: Row) => Math.max(r.quantity - r.doneQty, 0)
const short = computed(() => (finishing.value ? remainingOf(finishing.value) - finishQty.value : 0))
function openFinish(r: Row) {
  finishing.value = r
  finishQty.value = remainingOf(r)
  rest.value = 'CONTINUE'
  scrapNote.value = ''
}
async function doFinish() {
  const r = finishing.value
  if (!r) return
  if (short.value > 0 && rest.value === 'CONTINUE' && finishQty.value === 0) return showToast('部分完工至少 1 件')
  saving.value = true
  try {
    const body = short.value > 0 ? { source: 'MOBILE', qty: finishQty.value, rest: rest.value, note: rest.value === 'SCRAP' ? scrapNote.value || null : null } : { source: 'MOBILE' }
    const res = await $fetch(`/api/steps/${r.stepId}/finish`, { method: 'POST', body })
    showSuccessToast(short.value <= 0 ? '已完工' : rest.value === 'CONTINUE' ? `已报完工 ${finishQty.value} 件` : `已完工，报废已转异常 ${res.issueNo ?? ''}`)
    finishing.value = null
    await Promise.all([refresh(), refreshNuxtData('todos')])
  } catch (e) {
    showFailToast(apiError(e))
  } finally {
    saving.value = false
  }
}
/** 已完成数量占比（进度条），0–100 */
const donePercent = (r: Row) => (r.quantity > 0 ? Math.min(100, Math.round((r.doneQty / r.quantity) * 100)) : 0)
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
          <span>{{ r.mode === 'IN_PLANT_OUTSOURCE' ? (r.supplierName ?? '厂内外协') : `自制${r.supplierName ? ` · ${r.supplierName}` : ''}` }} · {{ r.quantity }} 件</span>
          <span :class="{ 'm-text-late': r.overdueDays > 0 }">{{ dueText(r) }}</span>
        </div>
        <div class="m-meta">
          <span>负责人 {{ r.ownerName ?? '—' }}</span>
          <span>开工 {{ dayText(r.startedAt) || '—' }}</span>
        </div>
        <div v-if="r.doneQty" class="m-progress">
          <van-progress :percentage="donePercent(r)" :show-pivot="false" class="m-progress-primary" />
          <span class="m-progress-text">已完成 {{ r.doneQty }}/{{ r.quantity }}</span>
        </div>
        <div v-if="canDo(me, 'stepAction', { workOrderNumber: r.workOrderNumber, ownerId: r.ownerId })" class="m-foot-row">
          <span class="m-spacer" />
          <van-button size="small" type="primary" @click="openFinish(r)">完工</van-button>
        </div>
      </MCard>
    </div>
    <div class="m-foot" />

    <van-dialog :show="!!finishing" title="完工" show-cancel-button :confirm-button-text="short > 0 && rest === 'CONTINUE' ? '报部分完工' : '确认完工'" :confirm-button-disabled="saving" @confirm="doFinish" @cancel="finishing = null">
      <div v-if="finishing" class="dialog">
        <p>{{ finishing.partName }} · {{ finishing.processName }}</p>
        <p class="m-muted tip">共 {{ finishing.quantity }} 件{{ finishing.doneQty ? `，已完成 ${finishing.doneQty} 件` : '' }}，本次完成：</p>
        <van-stepper v-model="finishQty" :min="0" :max="remainingOf(finishing)" integer />
        <template v-if="short > 0">
          <p class="tip short">还差 {{ short }} 件，剩下的：</p>
          <van-radio-group v-model="rest" direction="horizontal" class="rest">
            <van-radio name="CONTINUE">还在做（含返修）</van-radio>
            <van-radio name="SCRAP">报废了</van-radio>
          </van-radio-group>
          <van-field v-if="rest === 'SCRAP'" v-model="scrapNote" placeholder="报废原因（可空）" maxlength="200" class="note" />
          <p class="m-muted tip">{{ rest === 'CONTINUE' ? '工序继续加工，下一道先收到待办' : '本工序完成，报废的自动转异常，生产经理安排补料重做' }}</p>
        </template>
        <p v-else class="m-muted tip">完工后自动给下一道工序发待办</p>
      </div>
    </van-dialog>
  </div>
</template>

<style scoped>
.wo { font-size: 13px; color: var(--ft-text-2); font-weight: 500; }
.name { margin-top: 6px; }
.focus { border-color: var(--ft-primary); }
.dialog { padding: 12px 24px 20px; text-align: center; }
.tip { font-size: 12px; margin: 8px 0; }
.short { color: var(--ft-text); font-size: 13px; margin-top: 14px; }
.rest { justify-content: center; }
.note { margin-top: 8px; border: 1px solid var(--ft-border); border-radius: 8px; }
</style>
