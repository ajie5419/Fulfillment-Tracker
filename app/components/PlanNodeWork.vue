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
import type { CanCreate, PlanNodeRow, PlanTask } from '#shared/plan-view'

const props = withDefaults(defineProps<{ node: PlanNodeRow; wo: string; canCreate: CanCreate; viewOnly?: boolean }>(), { viewOnly: false })
const emit = defineEmits<{ changed: [] }>()

const get = $fetch as unknown as <T>(url: string, opts?: { query?: object }) => Promise<T>
const send = $fetch as unknown as <T = unknown>(url: string, opts: { method: 'POST' | 'PATCH' | 'DELETE'; body?: object }) => Promise<T>

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
const { data: master } = await useMaster()
const taskOpen = ref(false)
const taskEditing = ref<PlanTask | null>(null)
const taskForm = reactive<{ name: string; ownerId: string | undefined; planDate: Dayjs | undefined; note: string }>({ name: '', ownerId: undefined, planDate: undefined, note: '' })
function openTask(t: PlanTask | null) {
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
  if (!taskForm.name.trim()) return message.warning('请填写任务名称')
  if (!taskForm.ownerId) return message.warning('请选择责任人')
  if (!taskForm.planDate) return message.warning('请选择计划完成日')
  const body = { name: taskForm.name, ownerId: taskForm.ownerId, planDate: taskForm.planDate.format('YYYY-MM-DD'), note: taskForm.note || null }
  const t = taskEditing.value
  const ok = await act(
    () => (t ? send<{ planWarning: string | null }>(`/api/plan/tasks/${t.id}`, { method: 'PATCH', body }) : send<{ planWarning: string | null }>(`/api/plan/nodes/${props.node.id}/tasks`, { method: 'POST', body })),
    t ? '已保存' : '已新增，责任人会收到待办',
  )
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
    stepList.value = await get<StepOpt[]>(`/api/plan/nodes/${props.node.id}/steps`)
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
  const ok = await act(() => send<{ linked: number }>(`/api/plan/nodes/${props.node.id}/steps`, { method: 'POST', body: { stepIds: stepNew.value } }), (r) => `已关联 ${r.linked} 道工序`)
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

const taskColumns = [
  { title: '分解的任务', key: 'name' },
  { title: '类型', dataIndex: 'kindText', width: 84 },
  { title: '责任人', key: 'owner', width: 90 },
  { title: '计划完成', key: 'date', width: 150 },
  { title: '状态', key: 'status', width: 150 },
  { title: '', key: 'ops', width: 150 },
]
</script>

<template>
  <div class="work">
    <a-table v-if="node.tasks.length" class="ft-table" :columns="taskColumns" :data-source="node.tasks" :row-key="(t: PlanTask) => `${t.kind}:${t.id}`" size="small" :pagination="false">
      <template #bodyCell="{ column: c, record: t }">
        <template v-if="c.key === 'name'">
          <template v-if="t.kind === 'task'">
            {{ t.name }}
            <div v-if="t.note" class="muted">{{ t.note }}</div>
          </template>
          <NuxtLink v-else :to="t.link">{{ t.name }}</NuxtLink>
        </template>
        <template v-else-if="c.key === 'owner'">{{ t.ownerName ?? '—' }}</template>
        <template v-else-if="c.key === 'date'">
          <span :class="{ late: t.lateForNode && !t.done }">{{ t.planDate ?? '未填' }}</span>
          <span v-if="t.lateForNode && !t.done && !t.excluded" class="late small"> 晚于节点</span>
          <div v-if="t.kind !== 'task'" class="muted">{{ t.dateLabel }}</div>
        </template>
        <template v-else-if="c.key === 'status'">
          <span v-if="t.excluded" class="muted">{{ t.statusText }}（不计）</span>
          <template v-else-if="t.done">
            <UiStatusTag tone="done">{{ t.statusText }}</UiStatusTag>
            <div class="muted">{{ t.doneDate }}</div>
          </template>
          <template v-else>
            <UiStatusTag v-if="t.overdue" tone="late">逾期</UiStatusTag>
            <span v-else>{{ t.kind === 'task' ? '未完成' : t.statusText }}</span>
            <div v-if="t.expectedDate && t.expectedDate !== t.planDate" class="muted">预计 {{ t.expectedDate }}</div>
          </template>
        </template>
        <template v-else-if="c.key === 'ops'">
          <a-space v-if="t.kind === 'task'" :size="0" wrap>
            <a-button v-if="t.canDone && !t.done" type="link" size="small" @click="openTaskDone(t as PlanTask)">完成</a-button>
            <a-button v-if="t.canDone && t.done" type="link" size="small" @click="undoTask(t as PlanTask)">撤销完成</a-button>
            <template v-if="!viewOnly && t.canEdit">
              <a-button type="link" size="small" @click="openTask(t as PlanTask)">修改</a-button>
              <a-button type="link" size="small" danger @click="deleteTask(t as PlanTask)">删除</a-button>
            </template>
          </a-space>
        </template>
      </template>
    </a-table>
    <div v-else class="empty muted">{{ viewOnly ? '还没有分解：由责任部门在“部门计划”里接收后分解' : '还没有分解任务' }}</div>

    <div v-if="canAddTask || splitItems.length" class="adds">
      <a-button v-if="canAddTask" class="add" @click="openTask(null)">＋ 新增任务（名称 / 责任人 / 日期）</a-button>
      <a-button v-for="it in splitItems" :key="it.key" class="add" @click="onSplit(it.key)">{{ it.label }}</a-button>
      <UiHelpTip v-if="node.dept === 'TECH' || node.dept === 'PURCHASE'" label="已有记录怎么关联">已经建好的设计任务、采购行：在“设计任务”“采购到货”里编辑它，把“所属总计划节点”选成这个节点即可。</UiHelpTip>
    </div>

    <a-modal v-model:open="taskOpen" :title="taskEditing ? `修改任务：${taskEditing.name}` : `分解：${node.code} ${node.name}`" @ok="saveTask">
      <a-form layout="vertical">
        <a-form-item label="任务名称" required><a-input v-model:value="taskForm.name" :maxlength="191" placeholder="如：坡口加工、BOM 编制" /></a-form-item>
        <a-form-item label="责任人（会收到待办）" required>
          <a-select v-model:value="taskForm.ownerId" show-search option-filter-prop="label" :options="ownerOptions" placeholder="选择责任人" />
        </a-form-item>
        <a-form-item label="计划完成日" required>
          <a-date-picker v-model:value="taskForm.planDate" :allow-clear="false" style="width: 100%" />
          <div v-if="taskLate" class="late small">晚于节点计划日 {{ node.planDate }}，可以保存，项目计划里会标红</div>
        </a-form-item>
        <a-form-item label="备注"><a-input v-model:value="taskForm.note" :maxlength="500" /></a-form-item>
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
  </div>
</template>

<style scoped>
.work { display: flex; flex-direction: column; gap: 8px; }
.muted { color: var(--ft-text-2); font-size: 12px; }
.small { font-size: 12px; }
.late { color: var(--ft-late-text); }
.ok { color: var(--ft-done-text); }
.empty { padding: 4px 0; }
.adds { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.add { border-style: dashed; }
</style>
