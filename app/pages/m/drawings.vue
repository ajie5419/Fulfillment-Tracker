<script setup lang="ts">
/**
 * 手机：我的出图任务（R11）。我是设计负责人的任务：待出图（逾期、快到期的在前）/ 已出图；
 * 待出图的可直接"标记已出图"（出图日 = 今天）。发放、客户确认、改日期请到电脑端"出图任务"。
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
    await showConfirmDialog({ title: '标记已出图', message: `${r.componentName}（${r.workOrderNumber}）\n出图日期：今天` })
  } catch {
    return // 取消
  }
  busy.value = true
  try {
    const res = await drawingSend(`/api/drawings/${r.id}/drawn`, 'POST', {})
    showSuccessToast({ message: drawingResultText(res, '已标记出图'), duration: 2500 })
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
    <van-nav-bar title="我的出图任务" left-arrow @click-left="navigateTo('/m')" />
    <template v-if="focusId">
      <van-notice-bar v-if="focusError" color="#ee0a24" background="#fff1f0" :text="`提醒里的任务打不开：${focusError}`" />
      <template v-else-if="focus">
        <div class="section">提醒的任务<span class="link" @click="clearFocus">只看我的</span></div>
        <van-cell-group inset>
          <van-cell v-for="r in [focus]" :key="r.id" center>
            <template #title>
              <van-tag :type="r.overdue ? 'danger' : DRAWING_STATUS_TYPE[r.status]" class="tag">{{ r.overdue ? '逾期' : r.statusText }}</van-tag>
              <span class="name">{{ r.componentName }}</span>
              <div class="desc">{{ r.parts.length ? r.parts.map((p) => p.name).join('、') : '未关联工件' }}</div>
            </template>
            <template #label>
              {{ r.workOrderNumber }}　计划 {{ dayText(r.planDate) }}{{ r.drawnDate ? `　出图 ${dayText(r.drawnDate)}` : '' }}{{ r.needsCustomerConfirm ? (r.customerConfirmedDate ? '　客户已确认' : `　客户确认计划 ${r.customerPlanDate ? dayText(r.customerPlanDate) : '未定'}`) : '' }}
            </template>
            <template #right-icon>
              <van-button v-if="r.permissions.markDrawn" size="small" type="primary" :loading="busy" @click="markDrawn(r)">标记已出图</van-button>
              <span v-else-if="r.status === 'DRAWN'" class="muted">待发放</span>
            </template>
          </van-cell>
        </van-cell-group>
        <div class="section">我的出图任务</div>
      </template>
    </template>
    <van-tabs v-model:active="tab">
      <van-tab :title="`待出图${stats?.pending ? `（${stats.pending}）` : ''}`" name="pending" />
      <van-tab :title="`已出图${stats && stats.drawn + stats.customerPending ? `（${stats.drawn + stats.customerPending}）` : ''}`" name="drawn" />
    </van-tabs>
    <div v-if="stats?.overdue" class="hint">逾期 {{ stats.overdue }} 项，本周到期 {{ stats.dueThisWeek }} 项</div>
    <van-loading v-if="pending" class="center" />
    <van-empty v-else-if="!rows.length" :description="tab === 'pending' ? '没有待出图的任务' : '没有已出图待发放 / 待客户确认的任务'" image-size="80" />
    <van-cell-group v-else inset>
      <van-cell v-for="r in rows" :key="r.id" center>
        <template #title>
          <van-tag :type="r.overdue ? 'danger' : DRAWING_STATUS_TYPE[r.status]" class="tag">{{ r.overdue ? '逾期' : r.statusText }}</van-tag>
          <span class="name">{{ r.componentName }}</span>
          <div class="desc">{{ r.parts.length ? r.parts.map((p) => p.name).join('、') : '未关联工件' }}</div>
        </template>
        <template #label>
          {{ r.workOrderNumber }}　计划 {{ dayText(r.planDate) }}{{ r.drawnDate ? `　出图 ${dayText(r.drawnDate)}` : '' }}{{ r.needsCustomerConfirm ? (r.customerConfirmedDate ? '　客户已确认' : `　客户确认计划 ${r.customerPlanDate ? dayText(r.customerPlanDate) : '未定'}`) : '' }}
        </template>
        <template #right-icon>
          <van-button v-if="r.permissions.markDrawn" size="small" type="primary" :loading="busy" @click="markDrawn(r)">标记已出图</van-button>
          <span v-else-if="r.status === 'DRAWN'" class="muted">待发放</span>
        </template>
      </van-cell>
    </van-cell-group>
    <p class="muted foot">发放图纸、录客户确认请到电脑端"出图任务"。</p>
  </div>
</template>

<style scoped>
.center { display: flex; justify-content: center; padding: 32px; }
.tag { margin-right: 6px; }
.name { font-weight: 600; }
.desc { color: #323233; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hint { color: #ee0a24; font-size: 13px; padding: 8px 16px; }
.muted { color: #969799; font-size: 12px; }
.foot { padding: 12px 16px; }
.section { color: #646566; font-size: 13px; padding: 12px 16px 6px; display: flex; justify-content: space-between; }
.link { color: #1989fa; }
</style>
