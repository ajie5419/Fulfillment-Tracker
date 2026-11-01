<script setup lang="ts">
import { CONFIRM_TONE } from '~/utils/plan-status'

/**
 * 部门计划（zhao 10-23："发布项目计划 → 各部门模块接收自己这部分的计划，然后分解任务，委派责任人、给出分解后的计划日期"）。
 *   本部门在已发布项目计划里负责的末级节点，按工单分组；页签 待接收 / 执行中 / 已完成。
 *   待接收：接收并分解（接收后就地展开分解区）、退回（写原因，项目经理收到提醒）。
 *   执行中：分解任务（名称 / 责任人 / 计划完成日，晚于节点标红）、按部门新建设计任务 / 采购行 / 装配节点、关联已有工序 / 外协；标节点完成。
 *   领导、项目部负责人、管理员可以切换部门；?node= 定位节点（接收待办、超时提醒跳过来）。
 */
import dayjs from 'dayjs'
import { factoryDay } from '#shared/mobile-todo'
import type { DeptPlanNode, DeptPlanView } from '#shared/plan-view'

useHead({ title: '部门计划' })
const route = useRoute()
const router = useRouter()
const q = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : undefined)
const dept = computed({ get: () => q('dept'), set: (v) => void router.replace({ query: { ...route.query, dept: v, node: undefined } }) })
const wo = computed({ get: () => q('wo'), set: (v) => void router.replace({ query: { ...route.query, wo: v || undefined } }) })
const focusId = computed(() => q('node'))

const EMPTY: DeptPlanView = { dept: null, deptText: null, deptOptions: [], workOrderOptions: [], groups: [], summary: { pending: 0, returned: 0, unsplit: 0, overdueTasks: 0, dueSoonTasks: 0, active: 0, done: 0 }, focusNodeId: null }
const { data, pending, error, refresh } = await useFetch<DeptPlanView>('/api/plan/dept', {
  query: computed(() => ({ dept: dept.value, wo: wo.value, node: focusId.value })),
  default: () => EMPTY,
})

type Tab = DeptPlanNode['tab']
const tab = ref<Tab>('pending')
/** 本次在页面上刚接收的节点：留在"待接收"里就地分解，刷新 / 换页签后归到"执行中" */
const justAccepted = ref<string[]>([])
watch(tab, () => (justAccepted.value = []))
// 首次进来：没有待接收的就看执行中；定位节点时切到它所在的页签并滚过去
/** 定位只做一次：之后接收、分解刷新数据时不再把页签拉回定位节点 */
let handledFocus: string | null = null
watch(
  () => data.value,
  async (v, old) => {
    const focus = v.focusNodeId ? v.groups.flatMap((g) => g.nodes).find((n) => n.id === v.focusNodeId) : null
    if (focus && focus.id !== handledFocus) {
      handledFocus = focus.id
      tab.value = focus.tab
      await nextTick()
      if (import.meta.client) document.getElementById(`node-${focus.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } else if (!focus && (!old || old === EMPTY)) {
      if (!v.summary.pending && v.summary.active) tab.value = 'active'
    }
  },
  { immediate: true },
)

const inTab = (n: DeptPlanNode) => n.tab === tab.value || (tab.value === 'pending' && justAccepted.value.includes(n.id))
const groups = computed(() => data.value.groups.map((g) => ({ ...g, shown: g.nodes.filter(inTab) })).filter((g) => g.shown.length))
const tabOptions = computed(() => [
  { value: 'pending', label: `待接收 ${data.value.summary.pending}` },
  { value: 'returned', label: `已退回 ${data.value.summary.returned}` },
  { value: 'active', label: `执行中 ${data.value.summary.active}` },
  { value: 'done', label: '已完成' },
])

const send = $fetch as unknown as <T = unknown>(url: string, opts: { method: 'POST'; body?: object }) => Promise<T>
async function act(fn: () => Promise<unknown>, ok: string) {
  try {
    await fn()
    message.success(ok)
    return true
  } catch (e) {
    message.error(apiError(e))
    return false
  } finally {
    await Promise.all([refresh(), refreshReminders()])
  }
}
async function accept(n: DeptPlanNode) {
  if (await act(() => send(`/api/plan/nodes/${n.id}/confirm`, { method: 'POST', body: {} }), '已接收，请在下面分解任务、指定责任人')) {
    if (tab.value === 'pending') justAccepted.value = [...justAccepted.value, n.id]
  }
}
const rejectOpen = ref(false)
const rejecting = ref<DeptPlanNode | null>(null)
const rejectText = ref('')
function askReject(n: DeptPlanNode) {
  rejecting.value = n
  rejectText.value = ''
  rejectOpen.value = true
}
async function submitReject() {
  const n = rejecting.value
  if (!n) return
  if (!rejectText.value.trim()) return message.warning('请写退回原因')
  if (await act(() => send(`/api/plan/nodes/${n.id}/reject`, { method: 'POST', body: { reason: rejectText.value } }), '已退回，项目经理会收到提醒')) rejectOpen.value = false
}

// 节点完成（手动）
const doneOpen = ref(false)
const doneNode = ref<DeptPlanNode | null>(null)
const doneDate = ref(dayjs(factoryDay(new Date())))
function openDone(n: DeptPlanNode) {
  doneNode.value = n
  doneDate.value = dayjs(factoryDay(new Date()))
  doneOpen.value = true
}
async function submitDone() {
  const n = doneNode.value
  if (!n) return
  if (await act(() => send(`/api/plan/nodes/${n.id}/complete`, { method: 'POST', body: { date: doneDate.value.format('YYYY-MM-DD') } }), '已标记完成')) doneOpen.value = false
}
const undoDone = (n: DeptPlanNode) => act(() => send(`/api/plan/nodes/${n.id}/undo-complete`, { method: 'POST', body: {} }), '已撤销完成')

const md = (d: string | null) => (d ? d.slice(5) : '')
const planText = (n: DeptPlanNode) => (n.startDate && n.startDate !== n.planDate ? `${md(n.startDate)} ~ ${md(n.planDate)}` : md(n.planDate))
</script>

<template>
  <div class="ft-page">
    <a-result v-if="error" status="error" title="部门计划加载失败" :sub-title="apiError(error)">
      <template #extra><a-button type="primary" @click="refresh()">重试</a-button></template>
    </a-result>
    <a-result v-else-if="!pending && !data.deptOptions.length" status="info" title="你还没有对应的业务部门" sub-title="部门计划按业务部门显示。请管理员在“设置 → 部门对照”里把你的 QMS 部门对应到业务部门。" />
    <template v-else>
      <div class="ft-stats">
        <UiStatCard label="已退回" :value="data.summary.returned" unit="个节点" tone="late" clickable :active="tab === 'returned'" @click="tab = 'returned'" />
        <UiStatCard label="待接收" :value="data.summary.pending" unit="个节点" tone="risk" accent icon="warn" clickable :active="tab === 'pending'" sub="项目计划已发布，等本部门接收" @click="tab = 'pending'" />
        <UiStatCard label="已接收未分解" :value="data.summary.unsplit" unit="个节点" tone="primary" accent icon="dot" clickable :active="tab === 'active'" sub="还没分解任务、指定责任人" @click="tab = 'active'" />
        <UiStatCard label="任务逾期" :value="data.summary.overdueTasks" unit="项" tone="late" accent icon="alert" sub="分解的任务过了计划完成日" />
        <UiStatCard label="本周到期" :value="data.summary.dueSoonTasks" unit="项" tone="upstream" accent icon="ring" sub="7 天内到期、还没完成的任务" />
      </div>

      <UiSectionCard padding="none">
        <template #title>
          <span class="ft-title">部门计划<template v-if="data.deptText"> · {{ data.deptText }}</template>
            <UiHelpTip label="部门计划说明">项目部发布项目计划后，各部门在这里接收本部门负责的节点：接收后分解任务、指定责任人、给计划完成日（晚于节点日会标红）；做不到就退回并写原因，项目经理会收到提醒。汇总行（有子节点的节点）不用接收，按子节点算。</UiHelpTip>
          </span>
        </template>
        <template #extra>
          <a-space wrap>
            <a-segmented v-model:value="tab" :options="tabOptions" aria-label="切换待接收 / 执行中 / 已完成" />
            <a-select v-if="data.deptOptions.length > 1" :value="data.dept ?? undefined" :options="data.deptOptions" style="width: 110px" aria-label="部门" @change="(v: unknown) => (dept = v as string)" />
            <a-select v-model:value="wo" allow-clear show-search option-filter-prop="label" placeholder="全部工单" style="width: 200px" :options="data.workOrderOptions" aria-label="工单" />
            <UiRefreshButton @click="refresh()" />
          </a-space>
        </template>

        <a-spin :spinning="pending">
          <a-empty v-if="!groups.length" class="empty" :description="tab === 'returned' ? '没有已退回的节点' : tab === 'pending' ? '没有待接收的节点' : tab === 'active' ? '没有执行中的节点' : '还没有完成的节点'" />
          <div v-for="g in groups" :key="g.workOrder.workOrderNumber" class="group">
            <div class="group-head">
              <NuxtLink :to="{ path: '/plan', query: { wo: g.workOrder.workOrderNumber } }" class="wo">{{ g.workOrder.workOrderNumber }}</NuxtLink>
              <span class="proj">{{ g.workOrder.projectName ?? g.workOrder.customerName }}</span>
              <span class="ft-muted small">
                · 交期 {{ g.workOrder.deliveryDate ?? '—' }}
                <template v-if="(g.deliveryDelayDays ?? 0) > 0"> · <span class="late">预计 {{ g.expectedDelivery }}，拖期 {{ g.deliveryDelayDays }} 天</span></template>
                <template v-if="g.workOrder.projectManagerName"> · 项目经理 {{ g.workOrder.projectManagerName }}</template>
                <template v-if="g.publishedDay"> · {{ g.publishedByName ?? '' }} {{ g.publishedDay }} 发布</template>
              </span>
            </div>

            <div v-for="n in g.shown" :id="`node-${n.id}`" :key="n.id" class="node" :class="{ focus: n.id === data.focusNodeId }">
              <div class="node-head">
                <div class="node-main">
                  <div class="node-title">
                    <span class="code">{{ n.code }}</span>{{ n.name }}
                    <span v-if="n.parentName" class="ft-muted small">（{{ n.parentName }} 下）</span>
                  </div>
                  <div class="ft-muted small meta">
                    计划 {{ planText(n) }}
                    <template v-if="n.preds.length"> · 前置 {{ n.preds.map((p) => `${p.code} ${p.name}`).join('、') }}</template>
                    <template v-if="!n.done && n.delayDays > 0">
                      · <span class="late">预计 {{ md(n.expectedDate) }}，晚 {{ n.delayDays }} 天<template v-if="n.upstream && n.pushedBy">（受 {{ n.pushedBy.code }} {{ n.pushedBy.name }} 影响）</template></span>
                    </template>
                    <template v-if="n.done"> · 实际完成 {{ n.actualDate }}</template>
                    <template v-if="n.affects.length"> · 晚了影响 {{ n.affects.length }} 个节点</template>
                  </div>
                  <div v-if="n.note" class="ft-muted small">{{ n.note }}</div>
                  <div v-if="n.confirmStatus === 'REJECTED' && n.rejectReason" class="late small">{{ n.confirmedByName }} 退回：{{ n.rejectReason }}（等项目经理调整）</div>
                </div>
                <div class="node-side">
                  <UiStatusTag v-if="n.done" tone="done">已完成</UiStatusTag>
                  <UiStatusTag v-else-if="n.confirmStatus" :tone="CONFIRM_TONE[n.confirmStatus]">{{ n.confirmText }}<template v-if="n.confirmStatus === 'CONFIRMED' && n.confirmedByName"> · {{ n.confirmedByName }} {{ md(n.confirmedDay) }}</template></UiStatusTag>
                  <a-tag v-if="n.confirmAlertLevel && n.confirmStatus === 'PENDING'" color="orange">超时</a-tag>
                  <template v-if="n.tab === 'pending' && n.canConfirm">
                    <a-button v-if="n.confirmStatus === 'PENDING'" @click="askReject(n)">退回（写原因）</a-button>
                    <a-button type="primary" @click="accept(n)">{{ n.confirmStatus === 'REJECTED' ? '改为接收' : '接收并分解' }}</a-button>
                  </template>
                  <span v-else-if="n.tab === 'pending'" class="ft-muted small">等部门负责人接收</span>
                  <template v-if="n.tab !== 'pending' && n.canComplete">
                    <a-button v-if="!n.done" size="small" @click="openDone(n)">标节点完成</a-button>
                    <a-button v-else-if="n.doneBy === 'MANUAL'" size="small" @click="undoDone(n)">撤销完成</a-button>
                  </template>
                </div>
              </div>
              <div v-if="n.tab !== 'pending' || justAccepted.includes(n.id)" class="ft-well work">
                <PlanNodeWork :node="n" :wo="g.workOrder.workOrderNumber" :can-create="g.canCreate" :view-only="n.done" @changed="refresh()" />
              </div>
            </div>
          </div>
        </a-spin>
      </UiSectionCard>
    </template>

    <a-modal v-model:open="rejectOpen" :title="`退回节点：${rejecting?.code ?? ''} ${rejecting?.name ?? ''}`" @ok="submitReject">
      <p class="ft-muted">按这个日期做不到时退回，写清原因（如：原材料 12-20 才到，下料最早 12-22 完成）。项目经理会收到提醒，调整后会重新请你接收。</p>
      <a-textarea v-model:value="rejectText" :rows="3" :maxlength="500" placeholder="退回原因" />
    </a-modal>
    <a-modal v-model:open="doneOpen" :title="`标记完成：${doneNode?.code ?? ''} ${doneNode?.name ?? ''}`" @ok="submitDone">
      <a-form layout="vertical">
        <a-form-item label="完成日期"><a-date-picker v-model:value="doneDate" :allow-clear="false" style="width: 100%" /></a-form-item>
      </a-form>
      <p class="ft-muted">节点下的任务全部完成时会自动算完成，不用手动标。</p>
    </a-modal>
  </div>
</template>

<style scoped>
.small { font-size: 12px; }
.late { color: var(--ft-late-text); }
.empty { padding: 40px 0; }
.group { border-top: 1px solid var(--ft-border); }
.group:first-child { border-top: 0; }
.group-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; padding: 12px 20px; background: var(--ft-fill); }
.wo { font-weight: 600; }
.proj { font-weight: 600; color: var(--ft-text); }
.node { padding: 14px 20px; border-top: 1px solid var(--ft-border); display: flex; flex-direction: column; gap: 10px; }
.node.focus { background: var(--ft-risk-bg); }
.node-head { display: flex; align-items: flex-start; gap: 16px; }
.node-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.node-title { font-weight: 600; color: var(--ft-text); }
.code { display: inline-block; min-width: 40px; margin-right: 6px; color: var(--ft-text-2); font-weight: 500; font-variant-numeric: tabular-nums; }
.meta { line-height: 1.6; }
.node-side { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.work { padding: 12px; }
@media (max-width: 760px) {
  .node-head { flex-direction: column; }
  .node-side { justify-content: flex-start; }
}
</style>
