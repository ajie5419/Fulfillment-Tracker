<script setup lang="ts">
import { toneOfVant } from '#shared/mobile-todo'

/**
 * 手机：我的设计任务（R11）。我是设计负责人的任务：设计中（逾期、快到期的在前）/ 设计完成；
 * 设计中的可直接"标记设计完成"（设计完成日 = 今天）。发放、客户确认、改日期请到电脑端"设计任务"。
 * 从 W7 提醒点进来时带 ?id=：顶部单独展示这条任务（按能否看到该工单判权限），被升级通知的部门负责人 / PM 也能看到别人的任务。
 */
definePageMeta({ layout: 'mobile' })
const route = useRoute()
const router = useRouter()
const tab = ref<'pending' | 'drawn'>(route.query.tab === 'drawn' ? 'drawn' : 'pending')
watch(tab, (t) => router.replace({ query: { ...route.query, tab: t } }))
const { data, pending, refresh } = await useFetch('/api/drawings', {
  query: computed(() => ({ mine: '1', view: tab.value })),
  default: () => ({ rows: [] as DrawingRow[], total: 0, stats: null as DrawingStats | null }),
})
const rows = computed(() => (data.value.rows as DrawingRow[]).filter((r) => r.id !== focus.value?.id))
const focusId = computed(() => (typeof route.query.id === 'string' && route.query.id ? route.query.id : ''))
const focus = ref<DrawingRow | null>(null)
const focusError = ref('')
async function loadFocus() {
  focusError.value = ''
  if (!focusId.value) return void (focus.value = null)
  try {
    focus.value = await fetchDrawing(focusId.value)
  } catch (e) {
    focus.value = null
    focusError.value = apiError(e)
  }
}
watch(focusId, loadFocus)
onMounted(loadFocus)
function clearFocus() {
  const { id: _id, ...rest } = route.query
  router.replace({ query: rest })
}
const stats = computed(() => data.value.stats as DrawingStats | null)

const busy = ref(false)
async function markDrawn(r: DrawingRow) {
  try {
    await showConfirmDialog({ title: '标记设计完成', message: `${r.componentName}（${r.workOrderNumber}）\n设计完成日期：今天` })
  } catch {
    return // 取消
  }
  busy.value = true
  try {
    const res = await drawingSend(`/api/drawings/${r.id}/drawn`, 'POST', {})
    showSuccessToast({ message: drawingResultText(res, '已标记设计完成'), duration: 2500 })
    await Promise.all([refresh(), focus.value?.id === r.id ? loadFocus() : undefined])
  } catch (e) {
    showFailToast(apiError(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <van-nav-bar title="我的设计任务" left-arrow @click-left="navigateTo('/m')" />
    <template v-if="focusId">
      <div v-if="focusError" class="m-hint late"><UiStatusIcon kind="alert" :size="14" />提醒里的任务打不开：{{ focusError }}</div>
      <template v-else-if="focus">
        <div class="m-section">提醒的任务<span class="m-section-extra link" role="button" @click="clearFocus">只看我的</span></div>
        <div class="m-list">
          <MCard v-for="r in [focus]" :key="r.id" :tone="r.overdue ? 'late' : toneOfVant(DRAWING_STATUS_TYPE[r.status])">
            <div class="m-row">
              <van-tag :type="r.overdue ? 'danger' : DRAWING_STATUS_TYPE[r.status]">{{ r.overdue ? '逾期' : r.statusText }}</van-tag>
              <span class="wo">{{ r.workOrderNumber }}</span>
            </div>
            <div class="m-title name">{{ r.componentName }}</div>
            <div class="m-desc parts">{{ r.parts.length ? partsText(r.parts.map((p) => p.name)) : '未关联工件' }}</div>
            <div class="m-meta">
              <span :class="{ 'm-text-late': r.overdue }">计划 {{ dayText(r.planDate) }}</span>
              <span v-if="r.drawnDate" class="m-text-done">设计完成 {{ dayText(r.drawnDate) }}</span>
              <span v-if="r.needsCustomerConfirm">{{ r.customerConfirmedDate ? '客户已确认' : `客户确认计划 ${r.customerPlanDate ? dayText(r.customerPlanDate) : '未定'}` }}</span>
            </div>
            <div v-if="r.permissions.markDrawn || r.status === 'DRAWN'" class="m-foot-row">
              <span class="m-spacer" />
              <van-button v-if="r.permissions.markDrawn" size="small" type="primary" :loading="busy" @click="markDrawn(r)">标记设计完成</van-button>
              <span v-else class="m-muted small">待发放</span>
            </div>
          </MCard>
        </div>
        <div class="m-section">我的设计任务</div>
      </template>
    </template>
    <van-tabs v-model:active="tab">
      <van-tab :title="`设计中${stats?.pending ? `（${stats.pending}）` : ''}`" name="pending" />
      <van-tab :title="`设计完成${stats && stats.drawn + stats.customerPending ? `（${stats.drawn + stats.customerPending}）` : ''}`" name="drawn" />
    </van-tabs>
    <div v-if="stats?.overdue" class="m-hint late"><UiStatusIcon kind="alert" :size="14" />逾期 {{ stats.overdue }} 项，本周到期 {{ stats.dueThisWeek }} 项</div>
    <van-loading v-if="pending" class="m-center" />
    <van-empty v-else-if="!rows.length" :description="tab === 'pending' ? '没有设计中的任务' : '没有设计完成待发放 / 待客户确认的任务'" image-size="80" />
    <div v-else class="m-list">
      <MCard v-for="r in rows" :key="r.id" :tone="r.overdue ? 'late' : toneOfVant(DRAWING_STATUS_TYPE[r.status])">
        <div class="m-row">
          <van-tag :type="r.overdue ? 'danger' : DRAWING_STATUS_TYPE[r.status]">{{ r.overdue ? '逾期' : r.statusText }}</van-tag>
          <span class="wo">{{ r.workOrderNumber }}</span>
        </div>
        <div class="m-title name">{{ r.componentName }}</div>
        <div class="m-desc parts">{{ r.parts.length ? partsText(r.parts.map((p) => p.name)) : '未关联工件' }}</div>
        <div class="m-meta">
          <span :class="{ 'm-text-late': r.overdue }">计划 {{ dayText(r.planDate) }}</span>
          <span v-if="r.drawnDate" class="m-text-done">设计完成 {{ dayText(r.drawnDate) }}</span>
          <span v-if="r.needsCustomerConfirm">{{ r.customerConfirmedDate ? '客户已确认' : `客户确认计划 ${r.customerPlanDate ? dayText(r.customerPlanDate) : '未定'}` }}</span>
        </div>
        <div v-if="r.permissions.markDrawn || r.status === 'DRAWN'" class="m-foot-row">
          <span class="m-spacer" />
          <van-button v-if="r.permissions.markDrawn" size="small" type="primary" :loading="busy" @click="markDrawn(r)">标记设计完成</van-button>
          <span v-else class="m-muted small">待发放</span>
        </div>
      </MCard>
    </div>
    <p class="m-foot">发放图纸、录客户确认请到电脑端"设计任务"。</p>
  </div>
</template>

<style scoped>
.wo { font-size: 13px; color: var(--ft-text-2); font-weight: 500; }
.name { margin-top: 6px; }
.parts { color: var(--ft-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.small { font-size: 12px; }
.link { color: var(--ft-primary); }
</style>
