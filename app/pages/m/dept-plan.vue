<script setup lang="ts">
/**
 * 手机：部门计划（zhao 10-23）。和电脑端 /dept-plan 同一个接口：本部门在已发布项目计划里负责的节点，
 *   待接收：接收 / 退回（写原因）；执行中：看分解的任务、新增任务（名称 / 责任人 / 计划完成日）、任务负责人标完成。
 * 新建设计任务 / 采购行 / 装配节点、关联工序请到电脑端"部门计划"。?node= 定位节点（接收待办、提醒跳过来）。
 */
import type { DeptPlanNode, DeptPlanView, PlanTask } from '#shared/plan-view'

definePageMeta({ layout: 'mobile' })
const route = useRoute()
const router = useRouter()
const q = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : undefined)
const dept = computed(() => q('dept'))
const focusId = computed(() => q('node'))

const EMPTY: DeptPlanView = { dept: null, deptText: null, deptOptions: [], workOrderOptions: [], groups: [], summary: { pending: 0, unsplit: 0, overdueTasks: 0, dueSoonTasks: 0, active: 0, done: 0 }, focusNodeId: null }
const { data, pending, refresh } = await useFetch<DeptPlanView>('/api/plan/dept', {
  query: computed(() => ({ dept: dept.value, node: focusId.value })),
  default: () => EMPTY,
})

type Tab = DeptPlanNode['tab']
const tab = ref<Tab>('pending')
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
      document.getElementById(`m-node-${focus.id}`)?.scrollIntoView({ block: 'center' })
    } else if (!focus && (!old || old === EMPTY)) {
      if (!v.summary.pending && v.summary.active) tab.value = 'active'
    }
  },
  { immediate: true },
)
const cards = computed(() =>
  data.value.groups.flatMap((g) => g.nodes.filter((n) => n.tab === tab.value).map((n) => ({ node: n, wo: g.workOrder.workOrderNumber, project: g.workOrder.projectName ?? g.workOrder.customerName }))),
)

// 部门切换（领导、项目部负责人、管理员）
const showDept = ref(false)
const deptColumns = computed(() => data.value.deptOptions.map((d) => ({ text: d.label, value: d.value })))
function onDept({ selectedValues }: { selectedValues: string[] }) {
  showDept.value = false
  router.replace({ query: { dept: selectedValues[0] } })
}

const busy = ref(false)
const send = $fetch as unknown as <T = unknown>(url: string, opts: { method: 'POST'; body?: object }) => Promise<T>
async function run(fn: () => Promise<unknown>, ok: string) {
  busy.value = true
  try {
    await fn()
    showSuccessToast(ok)
    return true
  } catch (e) {
    showFailToast(apiError(e))
    return false
  } finally {
    busy.value = false
    await refresh()
  }
}
const accept = (n: DeptPlanNode) => run(() => send(`/api/plan/nodes/${n.id}/confirm`, { method: 'POST', body: {} }), '已接收，到"执行中"分解任务')

// 退回
const rejectNode = ref<DeptPlanNode | null>(null)
const rejectText = ref('')
function askReject(n: DeptPlanNode) {
  rejectNode.value = n
  rejectText.value = ''
}
async function submitReject() {
  const n = rejectNode.value
  if (!n) return
  if (!rejectText.value.trim()) return showFailToast('请写退回原因')
  if (await run(() => send(`/api/plan/nodes/${n.id}/reject`, { method: 'POST', body: { reason: rejectText.value } }), '已退回，项目经理会收到提醒')) rejectNode.value = null
}

// 新增任务
const { data: master } = await useMaster()
const taskNode = ref<DeptPlanNode | null>(null)
const taskForm = reactive({ name: '', ownerId: '', planDate: '' })
const showOwner = ref(false)
const showDate = ref(false)
function openTask(n: DeptPlanNode) {
  taskNode.value = n
  Object.assign(taskForm, { name: '', ownerId: '', planDate: n.planDate })
}
const ownerColumns = computed(() =>
  [...master.value.users]
    .sort((a, b) => Number(b.businessDept === taskNode.value?.dept) - Number(a.businessDept === taskNode.value?.dept))
    .map((u) => ({ text: `${u.name}（${u.department}）`, value: u.id })),
)
const ownerName = computed(() => master.value.users.find((u) => u.id === taskForm.ownerId)?.name ?? '')
function onOwner({ selectedValues }: { selectedValues: string[] }) {
  taskForm.ownerId = selectedValues[0] ?? ''
  showOwner.value = false
}
const pad = (x: number) => String(x).padStart(2, '0')
function onDate({ selectedValues }: { selectedValues: string[] }) {
  taskForm.planDate = selectedValues.join('-')
  showDate.value = false
}
const minDate = new Date(new Date().getFullYear() - 1, 0, 1)
const maxDate = new Date(new Date().getFullYear() + 3, 11, 31)
const taskLate = computed(() => !!taskNode.value && taskForm.planDate > taskNode.value.planDate)
async function saveTask() {
  const n = taskNode.value
  if (!n) return
  if (!taskForm.name.trim()) return showFailToast('请填写任务名称')
  if (!taskForm.ownerId) return showFailToast('请选择责任人')
  if (await run(() => send(`/api/plan/nodes/${n.id}/tasks`, { method: 'POST', body: { name: taskForm.name, ownerId: taskForm.ownerId, planDate: taskForm.planDate, note: null } }), '已新增，责任人会收到待办')) taskNode.value = null
}
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const doneTask = (t: PlanTask) => run(() => send(`/api/plan/tasks/${t.id}/complete`, { method: 'POST', body: { date: today() } }), '已完成')

const CONFIRM_TYPE = { PENDING: 'warning', CONFIRMED: 'success', REJECTED: 'danger' } as const
const CONFIRM_TONE = { PENDING: 'risk', CONFIRMED: 'done', REJECTED: 'late' } as const
const toneOf = (n: DeptPlanNode) => (n.done ? 'done' : !n.done && n.delayDays > 0 ? 'late' : n.confirmStatus ? CONFIRM_TONE[n.confirmStatus] : 'none')
const md = (d: string | null) => (d ? d.slice(5) : '')
</script>

<template>
  <div>
    <van-nav-bar :title="`部门计划${data.deptText ? ` · ${data.deptText}` : ''}`" left-arrow @click-left="navigateTo('/m')">
      <template v-if="data.deptOptions.length > 1" #right><span class="link" role="button" @click="showDept = true">换部门</span></template>
    </van-nav-bar>
    <van-tabs v-model:active="tab">
      <van-tab :title="`待接收${data.summary.pending ? `（${data.summary.pending}）` : ''}`" name="pending" />
      <van-tab :title="`执行中${data.summary.active ? `（${data.summary.active}）` : ''}`" name="active" />
      <van-tab title="已完成" name="done" />
    </van-tabs>
    <div v-if="tab === 'active' && (data.summary.unsplit || data.summary.overdueTasks)" class="m-hint late">
      <UiStatusIcon kind="alert" :size="14" />
      <template v-if="data.summary.unsplit">{{ data.summary.unsplit }} 个节点还没分解</template>
      <template v-if="data.summary.unsplit && data.summary.overdueTasks">，</template>
      <template v-if="data.summary.overdueTasks">任务逾期 {{ data.summary.overdueTasks }} 项</template>
    </div>
    <van-loading v-if="pending" class="m-center" />
    <van-empty v-else-if="!data.deptOptions.length" description="你还没有对应的业务部门，请管理员在设置里配置部门对照" image-size="80" />
    <van-empty v-else-if="!cards.length" :description="tab === 'pending' ? '没有待接收的节点' : tab === 'active' ? '没有执行中的节点' : '还没有完成的节点'" image-size="80" />
    <div v-else class="m-list">
      <MCard v-for="c in cards" :id="`m-node-${c.node.id}`" :key="c.node.id" :tone="toneOf(c.node)" :class="{ focus: c.node.id === data.focusNodeId }">
        <div class="m-row">
          <van-tag v-if="c.node.done" type="success">已完成</van-tag>
          <van-tag v-else-if="c.node.confirmStatus" :type="CONFIRM_TYPE[c.node.confirmStatus]">{{ c.node.confirmText }}</van-tag>
          <span class="wo">{{ c.wo }} {{ c.project ?? '' }}</span>
        </div>
        <div class="m-title name">{{ c.node.code }} {{ c.node.name }}</div>
        <div v-if="c.node.parentName" class="m-desc">{{ c.node.parentName }} 下</div>
        <div class="m-meta">
          <span>计划 {{ c.node.startDate && c.node.startDate !== c.node.planDate ? `${md(c.node.startDate)} ~ ` : '' }}{{ md(c.node.planDate) }}</span>
          <span v-if="!c.node.done && c.node.delayDays > 0" class="m-text-late">预计 {{ md(c.node.expectedDate) }}，晚 {{ c.node.delayDays }} 天</span>
          <span v-if="c.node.done">完成 {{ md(c.node.actualDate) }}</span>
        </div>
        <div v-if="c.node.confirmStatus === 'REJECTED' && c.node.rejectReason" class="m-desc m-text-late">退回：{{ c.node.rejectReason }}</div>

        <!-- 分解的任务 -->
        <div v-if="c.node.tab !== 'pending'" class="tasks">
          <div v-if="!c.node.tasks.length" class="m-muted small">还没有分解任务</div>
          <div v-for="t in c.node.tasks" :key="`${t.kind}:${t.id}`" class="task">
            <div class="task-main">
              <div>{{ t.name }}<span class="m-muted small">　{{ t.kind === 'task' ? (t.ownerName ?? '') : t.kindText }}</span></div>
              <div class="small" :class="{ 'm-text-late': (t.overdue || t.lateForNode) && !t.done }">
                {{ t.done ? `完成 ${md(t.doneDate)}` : `计划 ${md(t.planDate) || '未填'}` }}<template v-if="t.overdue && !t.done"> · 逾期</template><template v-else-if="t.lateForNode && !t.done"> · 晚于节点</template>
              </div>
            </div>
            <van-button v-if="t.canDone && !t.done" size="mini" type="primary" plain :loading="busy" @click="doneTask(t)">完成</van-button>
          </div>
        </div>

        <div class="m-foot-row">
          <span class="m-spacer" />
          <template v-if="c.node.tab === 'pending' && c.node.canConfirm">
            <van-button v-if="c.node.confirmStatus === 'PENDING'" size="small" :disabled="busy" @click="askReject(c.node)">退回</van-button>
            <van-button size="small" type="primary" :loading="busy" @click="accept(c.node)">{{ c.node.confirmStatus === 'REJECTED' ? '改为接收' : '接收' }}</van-button>
          </template>
          <span v-else-if="c.node.tab === 'pending'" class="m-muted small">等部门负责人接收</span>
          <van-button v-if="c.node.tab === 'active' && c.node.canSplit" size="small" type="primary" plain @click="openTask(c.node)">新增任务</van-button>
        </div>
      </MCard>
    </div>
    <p class="m-foot">新建设计任务、采购行、装配节点和关联工序请到电脑端“部门计划”。</p>

    <van-popup v-model:show="showDept" position="bottom" round>
      <van-picker title="部门" :columns="deptColumns" :model-value="data.dept ? [data.dept] : []" @confirm="onDept" @cancel="showDept = false" />
    </van-popup>

    <van-dialog :show="!!rejectNode" :title="`退回：${rejectNode?.code ?? ''} ${rejectNode?.name ?? ''}`" show-cancel-button :before-close="(a: string) => (a === 'confirm' ? (submitReject(), false) : ((rejectNode = null), true))">
      <van-field v-model="rejectText" type="textarea" rows="3" maxlength="500" placeholder="做不到的原因（项目经理会收到提醒）" />
    </van-dialog>

    <van-popup :show="!!taskNode" position="bottom" round closeable @update:show="(v: boolean) => { if (!v) taskNode = null }">
      <div class="m-section">分解：{{ taskNode?.code }} {{ taskNode?.name }}</div>
      <van-cell-group inset>
        <van-field v-model="taskForm.name" label="任务名称" maxlength="191" placeholder="如：坡口加工" />
        <van-cell title="责任人" :value="ownerName || '请选择'" is-link @click="showOwner = true" />
        <van-cell title="计划完成日" :value="taskForm.planDate" is-link @click="showDate = true" />
      </van-cell-group>
      <div v-if="taskLate" class="m-hint late">晚于节点计划日 {{ taskNode?.planDate }}，可以保存，项目计划里会标红</div>
      <div class="m-submit"><van-button type="primary" block round :loading="busy" @click="saveTask">保存</van-button></div>
    </van-popup>
    <van-popup v-model:show="showOwner" position="bottom" round>
      <van-picker title="责任人" :columns="ownerColumns" :model-value="taskForm.ownerId ? [taskForm.ownerId] : []" @confirm="onOwner" @cancel="showOwner = false" />
    </van-popup>
    <van-popup v-model:show="showDate" position="bottom" round>
      <van-date-picker title="计划完成日" :model-value="taskForm.planDate.split('-')" :min-date="minDate" :max-date="maxDate" @confirm="onDate" @cancel="showDate = false" />
    </van-popup>
  </div>
</template>

<style scoped>
.wo { font-size: 13px; color: var(--ft-text-2); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name { margin-top: 6px; }
.small { font-size: 12px; }
.link { color: var(--ft-primary); }
.focus { border-color: var(--ft-risk); }
.tasks { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--ft-border); display: flex; flex-direction: column; gap: 6px; }
.task { display: flex; align-items: center; gap: 8px; }
.task-main { flex: 1; min-width: 0; }
</style>
