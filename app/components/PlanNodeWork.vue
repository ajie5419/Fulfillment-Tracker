<script setup lang="ts">
/**
 * 一个计划节点下的部门任务（10-23 zhao：分解放到"部门计划"页，项目计划页只读看）。
 *   列表：节点下挂的设计任务 / 采购行 / 工序 / 装配节点 / 其他任务，日期晚于节点标红。
 *   viewOnly = false（部门计划页）：新增其他任务（名称 / 负责人 / 计划完成日）、按责任部门新建设计任务 / 采购行 / 装配节点、
 *     关联已有工序（含外协）；改 / 删其他任务。
 *   viewOnly = true（项目计划页）：只看；任务负责人仍能在这里标完成 / 撤销（待办会跳过来）。
 * 后端各接口自己再校验权限，这里只决定显示。
 */
import dayjs, { type Dayjs } from 'dayjs'
import { factoryDay } from '#shared/mobile-todo'
import { isPlanStartLate } from '#shared/plan-validation'
import type { CanCreate, PlanNodeRow, PlanTask } from '#shared/plan-view'

const props = withDefaults(defineProps<{ node: PlanNodeRow; wo: string; canCreate: CanCreate; viewOnly?: boolean; hideAddButton?: boolean }>(), { viewOnly: false, hideAddButton: false })
const emit = defineEmits<{ changed: [] }>()

const get = clientRequest
const send = clientRequest

async function act<T>(fn: () => Promise<T>, ok?: string | ((r: T) => string)) {
  try {
    const r = await fn()
    if (ok) message.success(typeof ok === 'function' ? ok(r) : ok)
    return r
  } catch (e) {
    message.error(apiError(e))
  } finally {
    emit('changed')
  }
}

// ───── 能做哪些分解（按节点责任部门）─────
type SplitKey = 'drawing' | 'purchase' | 'assembly' | 'steps'
const taskKind = ref<SplitKey | 'task'>('task')
const splitItems = computed<{ key: SplitKey; label: string }[]>(() => {
  if (props.viewOnly) return []
  const c = props.canCreate
  const n = props.node
  const items: { key: SplitKey; label: string }[] = []
  if (n.dept === 'TECH' && c.drawing) items.push({ key: 'drawing', label: '＋ 新建设计任务' })
  if (n.dept === 'PURCHASE' && c.purchase) items.push({ key: 'purchase', label: '＋ 新建采购行' })
  if (n.dept === 'PRODUCTION' && c.route) items.push({ key: 'steps', label: '＋ 关联已有工序 / 外协' })
  if (n.dept === 'PRODUCTION' && c.kitting) items.push({ key: 'assembly', label: '＋ 新建装配节点' })
  return items
})
const canAddTask = computed(() => !props.viewOnly && props.node.canSplit)
const splitOptions = computed(() => [
  ...splitItems.value.map((it) => ({ value: it.key, label: it.label.replace(/^＋ /, '').replace(/^新建/, '') })),
  ...(canAddTask.value ? [{ value: 'task' as const, label: '其他任务' }] : []),
])
const directTask = computed(() => taskKind.value === 'drawing' || taskKind.value === 'task')
const savingTask = ref(false)
const taskStart = ref<string | null>()
const taskFinish = computed({ get: () => taskForm.planDate?.format('YYYY-MM-DD'), set: (value: string | null | undefined) => { taskForm.planDate = value ? dayjs(value) : undefined } })
function openSplit() {
  openTask(null)
  taskKind.value = splitOptions.value[0]?.value ?? 'task'
  taskStart.value = props.node.startDate
}
const presetNode = computed(() => ({ id: props.node.id, planDate: props.node.planDate }))
const recordOpen = ref<'drawing' | 'purchase' | 'assembly' | null>(null)
function onSplit(key: SplitKey) {
  if (key === 'steps') return openSteps()
  recordOpen.value = key
}
function recordSaved() {
  recordOpen.value = null
  emit('changed')
}

// ───── 其他任务：新建 / 修改 / 删除 ─────
// Parent refs are resolved during async setup; expose actions before suspending.
const hasSplitAction = computed(() => canAddTask.value || splitItems.value.length > 0)
defineExpose({ openSplit, hasSplitAction })
const { data: master } = await useMaster()
const taskOpen = ref(false)
const taskEditing = ref<PlanTask | null>(null)
const taskForm = reactive<{ name: string; ownerId: string | undefined; planDate: Dayjs | undefined; note: string }>({ name: '', ownerId: undefined, planDate: undefined, note: '' })
function openTask(t: PlanTask | null) {
  taskKind.value = 'task'
  taskEditing.value = t
  Object.assign(taskForm, { name: t?.name ?? '', ownerId: t?.ownerId ?? undefined, planDate: dayjs(t?.planDate ?? props.node.planDate), note: t?.note ?? '' })
  taskOpen.value = true
}
/** 负责人下拉：节点责任部门的人排前面 */
const ownerOptions = computed(() =>
  [...master.value.users]
    .sort((a, b) => Number(b.businessDept === props.node.dept) - Number(a.businessDept === props.node.dept))
    .map((u) => ({ value: u.id, label: `${u.name}（${u.department}）` })),
)
const taskLate = computed(() => !!taskForm.planDate && taskForm.planDate.format('YYYY-MM-DD') > props.node.planDate)
async function saveTask() {
  if (savingTask.value) return
  if (!directTask.value && taskKind.value !== 'task' && taskKind.value !== 'drawing') {
    taskOpen.value = false
    return onSplit(taskKind.value)
  }
  if (!taskForm.name.trim()) return message.warning('请填写任务名称')
  if (!taskForm.ownerId) return message.warning('请选择责任人')
  if (!taskForm.planDate) return message.warning('请选择计划完成日')
  if (taskKind.value === 'drawing' && isPlanStartLate(taskStart.value, taskForm.planDate.format('YYYY-MM-DD'))) return message.warning('计划开始日不能晚于计划完成日')
  const body = { name: taskForm.name, ownerId: taskForm.ownerId, planDate: taskForm.planDate.format('YYYY-MM-DD'), note: taskForm.note || null }
  const t = taskEditing.value
  savingTask.value = true
  const ok = await act(
    () => taskKind.value === 'drawing'
      ? send('/api/drawings', { method: 'POST', body: { workOrderNumber: props.wo, planNodeId: props.node.id, componentName: body.name, ownerId: body.ownerId, startDate: taskStart.value ?? null, planDate: body.planDate, note: body.note, partIds: [], needsCustomerConfirm: false } })
      : (t ? send(`/api/plan/tasks/${t.id}`, { method: 'PATCH', body }) : send(`/api/plan/nodes/${props.node.id}/tasks`, { method: 'POST', body })),
    t ? '已保存' : '已分解并指派责任人',
  )
  savingTask.value = false
  if (ok?.planWarning) message.warning(ok.planWarning)
  if (ok) taskOpen.value = false
}
function deleteTask(t: PlanTask) {
  Modal.confirm({
    title: `删除任务"${t.name}"？`,
    content: '责任人的待办会一起作废',
    okType: 'danger',
    onOk: () => act(() => send(`/api/plan/tasks/${t.id}`, { method: 'DELETE', body: {} }), '已删除'),
  })
}
const undoTask = (t: PlanTask) => act(() => send(`/api/plan/tasks/${t.id}/undo-complete`, { method: 'POST', body: {} }), '已撤销完成，责任人会重新收到待办')

// ───── 任务完成（选日期）─────
const doneOpen = ref(false)
const taskDoing = ref<PlanTask | null>(null)
/** 默认完成日按工厂时区（Asia/Shanghai）的今天，避免浏览器时区跨零点时传成"明天"被服务端拒 */
const doneDate = ref<Dayjs>(dayjs(factoryDay(new Date())))
function openTaskDone(t: PlanTask) {
  taskDoing.value = t
  doneDate.value = dayjs(factoryDay(new Date()))
  doneOpen.value = true
}
async function submitDone() {
  const t = taskDoing.value
  if (!t) return
  const ok = await act(() => send(`/api/plan/tasks/${t.id}/complete`, { method: 'POST', body: { date: doneDate.value.format('YYYY-MM-DD') } }), '已完成')
  if (ok) doneOpen.value = false
}

// ───── 关联已有工序：同一工单的工序，已挂本节点的勾上且不能取消（取消挂靠在"生产管理"里改）─────
interface StepOpt { id: string; partName: string; processName: string; mode: string; status: string; dueDate: string | null; planNodeId: string | null; planNodeName: string | null }
const stepsOpen = ref(false)
const stepList = ref<StepOpt[]>([])
const stepsLoading = ref(false)
const stepPicked = ref<string[]>([])
async function openSteps() {
  stepList.value = []
  stepPicked.value = []
  stepsOpen.value = true
  stepsLoading.value = true
  try {
    stepList.value = await get(`/api/plan/nodes/${props.node.id}/steps`)
    stepPicked.value = stepList.value.filter((x) => x.planNodeId === props.node.id).map((x) => x.id)
  } catch (e) {
    message.error(apiError(e))
  } finally {
    stepsLoading.value = false
  }
}
const stepNew = computed(() => stepPicked.value.filter((id) => stepList.value.find((x) => x.id === id)?.planNodeId !== props.node.id))
async function saveSteps() {
  if (!stepNew.value.length) return message.warning('请勾选要挂到这个节点的工序')
  const ok = await act(() => send(`/api/plan/nodes/${props.node.id}/steps`, { method: 'POST', body: { stepIds: stepNew.value } }), (r) => `已关联 ${r.linked} 道工序`)
  if (ok) stepsOpen.value = false
}
const stepColumns = [
  { title: '工件', dataIndex: 'partName' },
  { title: '工序', dataIndex: 'processName', width: 140 },
  { title: '要求完成日', key: 'due', width: 110 },
  { title: '现在挂在', key: 'node', width: 150 },
]
const stepSelection = computed(() => ({
  selectedRowKeys: stepPicked.value,
  onChange: (keys: (string | number)[]) => (stepPicked.value = keys.map(String)),
  getCheckboxProps: (r: StepOpt) => ({ disabled: r.planNodeId === props.node.id }),
}))

</script>

<template>
  <div v-if="node.tasks.length || !hideAddButton" class="work">
    <div v-if="node.tasks.length" class="task-list">
      <div v-for="t in node.tasks" :key="`${t.kind}:${t.id}`" class="task-row">
        <div class="task-main">
          <span class="kind-tag">{{ t.kindText }}</span>
          <template v-if="t.kind === 'task'">
            <span class="task-name">{{ t.name }}</span>
            <span v-if="t.note" class="muted task-note">{{ t.note }}</span>
          </template>
          <NuxtLink v-else :to="t.link" class="task-name task-link">{{ t.name }}</NuxtLink>
        </div>

        <div class="task-meta">
          <span class="task-owner" title="责任人">{{ t.ownerName ?? '—' }}</span>
          <span class="task-date" :class="{ late: t.lateForNode && !t.done }" title="计划完成日">
            {{ t.planDate ?? '未填' }}
            <span v-if="t.lateForNode && !t.done && !t.excluded" class="late small">晚于节点</span>
          </span>
          <span class="task-status">
            <span v-if="t.excluded" class="muted">{{ t.statusText }}（不计）</span>
            <template v-else-if="t.done">
              <UiStatusTag tone="done">{{ t.statusText }}{{ t.doneDate ? ` · ${t.doneDate.slice(5)}` : '' }}</UiStatusTag>
            </template>
            <template v-else>
              <UiStatusTag v-if="t.overdue" tone="late">逾期{{ t.expectedDate && t.expectedDate !== t.planDate ? ` · 预计 ${t.expectedDate.slice(5)}` : '' }}</UiStatusTag>
              <span v-else class="status-pill">{{ t.kind === 'task' ? '未完成' : t.statusText }}</span>
            </template>
          </span>
          <div v-if="t.kind === 'task' && (t.canDone || (!viewOnly && t.canEdit))" class="task-ops">
            <a-button v-if="t.canDone && !t.done" size="small" @click="openTaskDone(t as PlanTask)">完成</a-button>
            <a-button v-if="t.canDone && t.done" size="small" @click="undoTask(t as PlanTask)">撤销</a-button>
            <template v-if="!viewOnly && t.canEdit">
              <a-button size="small" @click="openTask(t as PlanTask)">修改</a-button>
              <a-button size="small" class="op-del" @click="deleteTask(t as PlanTask)">删除</a-button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="!hideAddButton" class="empty-bar">
      <span class="muted">{{ viewOnly ? '还没有分解任务' : '暂未分解任务' }}</span>
      <a-button v-if="hasSplitAction" size="small" class="add-btn" @click="openSplit">＋ 分解任务</a-button>
    </div>

    <div v-if="node.tasks.length && !hideAddButton && hasSplitAction" class="work-foot">
      <a-button size="small" class="add-btn" @click="openSplit">＋ 追加任务</a-button>
    </div>
  </div>

    <a-modal v-model:open="taskOpen" :title="taskEditing ? `修改任务：${taskEditing.name}` : `分解任务：${node.code} ${node.name}`" :ok-text="directTask ? '保存并指派' : '继续填写'" :confirm-loading="savingTask" :closable="!savingTask" :mask-closable="!savingTask" :cancel-button-props="{ disabled: savingTask }" @ok="saveTask">
      <a-form layout="vertical">
        <a-form-item v-if="!taskEditing" label="任务类型">
          <a-select v-model:value="taskKind" :options="splitOptions" :disabled="savingTask" />
          <div class="muted" v-if="taskKind === 'drawing'">保存后显示在本节点、设计任务和责任人的工作台；图纸关联、客户确认要求可在设计任务中补充。</div>
          <div class="muted" v-else-if="taskKind === 'task'">用于会议、资料整理等辅助工作，不进入设计、采购等专项流程。</div>
        </a-form-item>
        <template v-if="directTask">
        <a-form-item label="任务名称" required><a-input v-model:value="taskForm.name" :maxlength="191" placeholder="如：坡口加工、BOM 编制" /></a-form-item>
        <a-form-item label="责任人（会收到待办）" required>
          <a-select v-model:value="taskForm.ownerId" show-search option-filter-prop="label" :options="ownerOptions" placeholder="选择责任人" />
        </a-form-item>
        <a-form-item v-if="taskKind === 'drawing'" label="计划开始日">
          <UiDatePicker v-model:value="taskStart" />
        </a-form-item>
        <a-form-item label="计划完成日" required>
          <UiDatePicker v-model:value="taskFinish" :allow-clear="false" />
          <div v-if="taskLate" class="late small">晚于节点计划日 {{ node.planDate }}，可以保存，项目计划里会标红</div>
        </a-form-item>
        <a-form-item label="备注"><a-input v-model:value="taskForm.note" :maxlength="500" /></a-form-item>
        </template>
      </a-form>
    </a-modal>

    <a-modal v-model:open="doneOpen" :title="`标记完成：${taskDoing?.name ?? ''}`" @ok="submitDone">
      <a-form layout="vertical">
        <a-form-item label="完成日期"><a-date-picker v-model:value="doneDate" :allow-clear="false" style="width: 100%" /></a-form-item>
      </a-form>
      <p class="muted">完成后责任人的待办关闭；节点下的任务全部完成时节点自动完成。</p>
    </a-modal>

    <a-modal v-model:open="stepsOpen" :title="`关联工序到节点：${node.code} ${node.name}`" :width="760" :ok-text="stepNew.length ? `关联 ${stepNew.length} 道` : '关联'" @ok="saveSteps">
      <p class="muted">勾选这个工单里要算在本节点下的工序（含外协工序）；已挂在别的节点的会改挂过来。取消关联请到“生产管理”里改。</p>
      <a-table class="ft-table" :columns="stepColumns" :data-source="stepList" :loading="stepsLoading" :row-selection="stepSelection" row-key="id" size="small" :pagination="false" :scroll="{ y: 400 }">
        <template #emptyText><a-empty description="这个工单还没有工序（先在“生产管理”里建工件和工序）" /></template>
        <template #bodyCell="{ column: c, record: r }">
          <template v-if="c.key === 'due'">
            <span :class="{ late: !!r.dueDate && r.dueDate > node.planDate }">{{ r.dueDate ?? '未填' }}</span>
          </template>
          <template v-else-if="c.key === 'node'">
            <span v-if="r.planNodeId === node.id" class="ok">本节点</span>
            <span v-else-if="r.planNodeName">{{ r.planNodeName }}</span>
            <span v-else class="muted">未挂</span>
          </template>
        </template>
      </a-table>
    </a-modal>

    <template v-if="!viewOnly">
      <DrawingEditModal :open="recordOpen === 'drawing'" :task="null" :work-order-number="wo" :preset-node="presetNode" @close="recordOpen = null" @done="recordSaved" />
      <PurchaseEditModal :open="recordOpen === 'purchase'" :line="null" :work-order-number="wo" :preset-node="presetNode" @close="recordOpen = null" @done="recordSaved" />
      <KittingNodeModal :open="recordOpen === 'assembly'" :node="null" :work-order-number="wo" :preset-node="presetNode" @close="recordOpen = null" @done="recordSaved" />
    </template>
</template>

<style scoped>
.work { border: 1px solid var(--ft-border); border-radius: var(--card-radius-inner); overflow: hidden; background: var(--ft-fill); }
.task-list { display: flex; flex-direction: column; }
.task-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 7px 12px; border-top: 1px solid var(--card-border-subtle); font-size: 13px; font-variant-numeric: tabular-nums; }
.task-row:first-child { border-top: 0; }
.task-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
.kind-tag { flex: none; padding: 0 6px; height: 20px; line-height: 20px; border-radius: 4px; background: var(--ft-card-bg); border: 1px solid var(--ft-border); color: var(--ft-text-2); font-size: 11px; }
.task-name { font-weight: 500; color: var(--ft-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-link { color: var(--ft-primary); }
.task-note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-meta { flex: none; display: flex; align-items: center; gap: 16px; white-space: nowrap; }
.task-owner { min-width: 68px; color: var(--ft-text-2); }
.task-date { min-width: 82px; color: var(--ft-text-2); }
.task-status { display: inline-flex; align-items: center; }
.status-pill { display: inline-block; padding: 0 8px; height: 22px; line-height: 22px; border-radius: 999px; background: var(--ft-card-bg); border: 1px solid var(--ft-border); color: var(--ft-text-2); font-size: 12px; white-space: nowrap; }
.task-ops { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.op-del { color: var(--ft-text-2); }
.op-del:hover, .op-del:focus-visible { color: var(--ft-late-text) !important; border-color: var(--ft-late) !important; background: var(--ft-late-bg) !important; }
.work-foot { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-top: 1px solid var(--card-border-subtle); }
.empty-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 12px; }
.muted { color: var(--ft-text-2); font-size: 12px; }
.small { font-size: 12px; }
.late { color: var(--ft-late-text); }
.ok { color: var(--ft-done-text); }
.add-btn { border-style: dashed; background: var(--ft-card-bg); }
@media (max-width: 760px) {
  .task-row { flex-direction: column; align-items: flex-start; gap: 6px; }
  .task-meta { flex-wrap: wrap; gap: 8px 12px; }
}
</style>
