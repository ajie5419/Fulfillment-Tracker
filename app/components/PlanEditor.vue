<script setup lang="ts">
/**
 * 总计划编辑（R14）：一个工单一份主线计划，部门记录（设计 / 采购 / 工序 / 装配节点）挂到节点上。
 * 用在"项目计划"页 /plan?wo=（zhao 10-22：一度并进工单详情的页签，测试后又单独成菜单页；旧的 /wo/:no?tab=plan 跳过来）。
 *   节点表：基线 / 当前计划 / 预计 / 实际日期、责任部门、确认状态、挂靠任务数、逾期数；展开看挂靠任务（可跳到各自页面）。
 *   10-22 按真实 MS Project 计划补：节点可设阶段（表格按阶段分组）、计划开始日、前置节点（多条线并行，只沿前置往后推），
 *     用了前置 / 开始日的计划显示余量和关键节点；"甘特图"视图（PlanGantt，只读）。
 *   顶部：合同交期、预计交期、拖期天数、未挂节点的部门记录条数。
 *   项目经理、项目部、管理员可按模板生成、增删改节点、发布（发布后改日期 / 加删节点要写原因，记调整记录）；
 *   责任部门负责人确认 / 退回；责任部门的人、项目经理可以手动标完成（挂靠任务全部完成也自动算完成）。
 *   部门计划二次分解（zhao 10-22）：节点行"部门任务"列的"+ 分解"——按责任部门新建设计任务 / 采购行 / 装配节点、挂工序（原来的记录，弹窗预选本节点），
 *     其他部门工作建"其他任务"（负责人收待办，截止日 = 计划完成日）；已发布但还没有任何部门任务的节点标"未分解"。
 * 地址栏 ?node= 定位节点（W9 提醒、确认待办跳过来）。所有人可见（看不到的工单接口会拒绝；手里有确认待办的部门负责人例外，见 server/utils/auth.ts）。
 */
import dayjs, { type Dayjs } from 'dayjs'
import { BUSINESS_DEPT_OPTIONS } from '#shared/business-depts'

interface PlanTask {
  kind: string
  kindText: string
  id: string
  name: string
  dateLabel: string
  planDate: string | null
  expectedDate: string | null
  doneDate: string | null
  done: boolean
  excluded: boolean
  overdue: boolean
  lateForNode: boolean
  statusText: string
  link: string
  /** 其他任务：负责人、备注、能否改 / 删、能否标完成（其余类型为空 / false） */
  ownerId: string | null
  ownerName: string | null
  note: string | null
  canEdit: boolean
  canDone: boolean
}
interface PlanNodeRow {
  id: string
  seq: number
  name: string
  dept: string
  deptText: string
  note: string | null
  /** 阶段（分组显示）、计划开始日（可选） */
  phase: string | null
  startDate: string | null
  planDate: string
  /** 前置节点：customDeps = false 时是默认的"上一个节点" */
  customDeps: boolean
  preds: { id: string; seq: number; name: string }[]
  /** 被哪个前置节点推后 */
  pushedBy: { seq: number; name: string } | null
  /** 余量（天）：≤ 0 = 关键节点；null = 不显示（一条主线、已完成、或后面没节点接着） */
  slackDays: number | null
  critical: boolean
  baselineDate: string | null
  expectedDate: string
  actualDate: string | null
  done: boolean
  doneBy: 'MANUAL' | 'AUTO' | null
  manualDoneByName: string | null
  delayDays: number
  driver: string
  /** 不计上游顺延的自身预计日 / 自身延误天数；source = 源头延误节点（W9 只报它），upstream = 受上游影响 */
  selfExpectedDate: string
  selfDelayDays: number
  source: boolean
  upstream: boolean
  confirmStatus: 'PENDING' | 'CONFIRMED' | 'REJECTED' | null
  confirmText: string | null
  confirmedByName: string | null
  rejectReason: string | null
  taskCount: number
  doneCount: number
  overdueCount: number
  lateCount: number
  alertLevel: 'YELLOW' | 'RED' | null
  confirmAlertLevel: 'REMIND' | 'YELLOW' | 'RED' | null
  tasks: PlanTask[]
  /** 未分解：节点下还没有任何部门任务；splitAlertLevel = W9 未分解提醒 */
  unsplit: boolean
  splitAlertLevel: 'REMIND' | null
  canSplit: boolean
  canConfirm: boolean
  canComplete: boolean
}
interface PlanView {
  workOrder: { workOrderNumber: string; projectName: string | null; customerName: string | null; deliveryDate: string | null; projectManagerName: string | null }
  plan: { status: 'DRAFT' | 'PUBLISHED'; templateName: string | null; publishedAt: string | null; publishedByName: string | null } | null
  expectedDelivery: string | null
  deliveryDelayDays: number | null
  delayedNodes: number
  sourceNodes: number
  planAlertLevel: 'YELLOW' | 'RED' | null
  unlinked: { drawing: number; purchase: number; step: number; assembly: number; total: number }
  /** 用了前置节点或开始日（多条线并行） */
  network: boolean
  /** 没有后续节点接着的节点（最后一个除外） */
  dangling: { id: string; seq: number; name: string }[]
  phases: string[]
  canEdit: boolean
  canCreate: { drawing: boolean; purchase: boolean; route: boolean; kitting: boolean }
  nodes: PlanNodeRow[]
  changeLogs: { id: string; nodeName: string; kind: 'DATE' | 'ADD' | 'DELETE'; oldDate: string | null; newDate: string | null; reason: string; actorName: string | null; createdAt: string }[]
}

const DEPTS = BUSINESS_DEPT_OPTIONS
const DRIVER_TEXT: Record<string, string> = { self: '', task: '挂靠任务拖后', prev: '前置节点顺延', today: '计划日已过仍未完成', actual: '' }
const LOG_KIND = { DATE: '改日期', ADD: '加节点', DELETE: '删节点' } as const

const props = defineProps<{ wo: string }>()
/** 节点有变动（生成、发布、改日期、确认、完成……）时通知工单详情刷新概览 */
const emit = defineEmits<{ changed: [] }>()
const route = useRoute()
const wo = computed(() => props.wo)
const focusNode = ref<string | null>((route.query.node as string) || null)

const get = $fetch as unknown as <T>(url: string, opts?: { query?: object }) => Promise<T>
const send = $fetch as unknown as <T = unknown>(url: string, opts: { method: 'POST' | 'PATCH' | 'DELETE'; body?: object }) => Promise<T>

const data = ref<PlanView | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
async function load() {
  if (!wo.value) {
    data.value = null
    return
  }
  loading.value = true
  loadError.value = null
  try {
    data.value = await get<PlanView>('/api/plan', { query: { workOrderNumber: wo.value } })
    if (focusNode.value && data.value.nodes.some((n) => n.id === focusNode.value)) {
      expanded.value = [focusNode.value]
      await nextTick()
      document.querySelector(`[data-row-key="${focusNode.value}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  } catch (e) {
    data.value = null
    loadError.value = apiError(e)
  } finally {
    loading.value = false
  }
}
watch(wo, load)
watch(
  () => route.query.node,
  (v) => {
    focusNode.value = (v as string) || null
    void load()
  },
)
onMounted(load)

const published = computed(() => data.value?.plan?.status === 'PUBLISHED')
const expanded = ref<string[]>([])

async function act<T>(fn: () => Promise<T>, ok?: string | ((r: T) => string)) {
  try {
    const r = await fn()
    if (ok) message.success(typeof ok === 'function' ? ok(r) : ok)
    return r
  } catch (e) {
    message.error(apiError(e))
  } finally {
    await load()
    emit('changed')
  }
}

// ───── 按模板生成 ─────
const { data: templates } = await useFetch<{ id: string; name: string; nodes: unknown[] }[]>('/api/plan/templates', { default: () => [] })
const templateId = ref<string | undefined>()
watch(templates, (list) => (templateId.value ??= list[0]?.id), { immediate: true })
function generate() {
  if (!templateId.value) return message.warning('请选择模板')
  const run = () => act(() => send<{ created: number }>('/api/plan/generate', { method: 'POST', body: { workOrderNumber: wo.value, templateId: templateId.value } }), (r) => `已生成 ${r.created} 个节点`)
  if (!data.value?.nodes.length) return run()
  Modal.confirm({ title: '按模板重新生成？', content: '现有节点会被替换，挂在上面的部门记录变成未挂', onOk: run })
}

// ───── 发布 ─────
function publish() {
  Modal.confirm({
    title: '发布总计划？',
    content: '发布后当前计划日记为基线，各节点请责任部门负责人确认；之后改日期、加删节点都要写原因。已发布工单新建部门记录必须选所属节点。',
    onOk: () =>
      act(
        () => send<{ todos: number; deptsWithoutHead: string[] }>('/api/plan/publish', { method: 'POST', body: { workOrderNumber: wo.value } }),
        (r) => `已发布，发出 ${r.todos} 条确认待办${r.deptsWithoutHead.length ? `（${r.deptsWithoutHead.join('、')}没有负责人，没人收到）` : ''}`,
      ),
  })
}

// ───── 新增 / 编辑节点 ─────
const editOpen = ref(false)
const editing = ref<PlanNodeRow | null>(null)
const form = reactive<{
  name: string
  dept: string
  phase: string
  startDate: Dayjs | undefined
  planDate: Dayjs | undefined
  seq: number | undefined
  /** default = 上一个节点；custom = 自己选（可以不选 = 没有前置） */
  depMode: 'default' | 'custom'
  preds: string[]
  note: string
  reason: string
}>({ name: '', dept: 'PROJECT', phase: '', startDate: undefined, planDate: undefined, seq: undefined, depMode: 'default', preds: [], note: '', reason: '' })
function openEdit(n: PlanNodeRow | null) {
  editing.value = n
  const last = data.value?.nodes.at(-1)
  Object.assign(form, {
    name: n?.name ?? '',
    dept: n?.dept ?? 'PROJECT',
    phase: n?.phase ?? (n ? '' : (last?.phase ?? '')),
    startDate: n?.startDate ? dayjs(n.startDate) : undefined,
    planDate: n ? dayjs(n.planDate) : undefined,
    seq: n?.seq ?? undefined,
    depMode: n?.customDeps ? 'custom' : 'default',
    preds: n?.customDeps ? n.preds.map((p) => p.id) : [],
    note: n?.note ?? '',
    reason: '',
  })
  editOpen.value = true
}
/** 前置节点下拉：同一份计划的其他节点 */
const predOptions = computed(() => (data.value?.nodes ?? []).filter((x) => x.id !== editing.value?.id).map((x) => ({ value: x.id, label: `#${x.seq} ${x.name}` })))
const phaseOptions = computed(() => (data.value?.phases ?? []).map((v) => ({ value: v })))
/** 默认前置 = 上一个节点：编辑时显示它是谁 */
const defaultPredText = computed(() => {
  const list = data.value?.nodes ?? []
  if (editing.value) {
    const i = list.findIndex((x) => x.id === editing.value!.id)
    return i > 0 ? `#${list[i - 1]!.seq} ${list[i - 1]!.name}` : '无（第一个节点）'
  }
  const last = list.at(-1)
  return last ? `#${last.seq} ${last.name}（排在最后时）` : '无'
})
const startLate = computed(() => !!form.startDate && !!form.planDate && form.startDate.isAfter(form.planDate, 'day'))
/** 发布后：加节点、改计划日都要写原因 */
const needReason = computed(() => published.value && (!editing.value || (!!form.planDate && form.planDate.format('YYYY-MM-DD') !== editing.value.planDate)))
async function saveNode() {
  if (!form.name.trim()) return message.warning('请填写节点名称')
  if (!form.planDate) return message.warning('请选择计划日期')
  if (startLate.value) return message.warning('计划开始日不能晚于计划完成日')
  if (needReason.value && !form.reason.trim()) return message.warning('总计划已发布，请写调整原因')
  const body = {
    name: form.name,
    dept: form.dept,
    phase: form.phase || null,
    startDate: form.startDate ? form.startDate.format('YYYY-MM-DD') : null,
    planDate: form.planDate.format('YYYY-MM-DD'),
    seq: form.seq ?? null,
    preds: form.depMode === 'custom' ? form.preds : null,
    note: form.note || null,
    reason: form.reason || null,
  }
  const ok = await act(
    () => (editing.value ? send<{ reconfirm?: boolean }>(`/api/plan/nodes/${editing.value.id}`, { method: 'PATCH', body }) : send<{ reconfirm?: boolean }>('/api/plan/nodes', { method: 'POST', body: { workOrderNumber: wo.value, ...body } })),
    (r) => (r.reconfirm || (!editing.value && published.value) ? '已保存，已重新请责任部门确认' : '已保存'),
  )
  if (ok) editOpen.value = false
}

// ───── 删除 ─────
const reasonOpen = ref(false)
const reasonText = ref('')
const reasonFor = ref<{ kind: 'delete' | 'reject'; node: PlanNodeRow } | null>(null)
function askReason(kind: 'delete' | 'reject', node: PlanNodeRow) {
  if (kind === 'delete' && !published.value) {
    return Modal.confirm({
      title: `删除节点"${node.name}"？`,
      content: '挂在上面的部门记录变成未挂',
      okType: 'danger',
      onOk: () => act(() => send(`/api/plan/nodes/${node.id}`, { method: 'DELETE', body: {} }), '已删除'),
    })
  }
  reasonFor.value = { kind, node }
  reasonText.value = ''
  reasonOpen.value = true
}
async function submitReason() {
  const r = reasonFor.value
  if (!r) return
  if (!reasonText.value.trim()) return message.warning(r.kind === 'reject' ? '请写退回原因' : '请写删除原因')
  const ok =
    r.kind === 'reject'
      ? await act(() => send(`/api/plan/nodes/${r.node.id}/reject`, { method: 'POST', body: { reason: reasonText.value } }), '已退回，项目经理会收到提醒')
      : await act(() => send(`/api/plan/nodes/${r.node.id}`, { method: 'DELETE', body: { reason: reasonText.value } }), '已删除')
  if (ok) reasonOpen.value = false
}

// ───── 确认 / 完成 ─────
const confirmNode = (n: PlanNodeRow) => act(() => send(`/api/plan/nodes/${n.id}/confirm`, { method: 'POST', body: {} }), '已确认')
const doneOpen = ref(false)
const doneNode = ref<PlanNodeRow | null>(null)
const doneDate = ref<Dayjs>(dayjs())
function openDone(n: PlanNodeRow) {
  taskDoing.value = null
  doneNode.value = n
  doneDate.value = dayjs()
  doneOpen.value = true
}
async function submitDone() {
  const n = doneNode.value
  const t = taskDoing.value
  const body = { date: doneDate.value.format('YYYY-MM-DD') }
  const ok = n
    ? await act(() => send(`/api/plan/nodes/${n.id}/complete`, { method: 'POST', body }), '已标记完成')
    : t
      ? await act(() => send(`/api/plan/tasks/${t.id}/complete`, { method: 'POST', body }), '已完成')
      : null
  if (ok) doneOpen.value = false
}
const undoDone = (n: PlanNodeRow) => act(() => send(`/api/plan/nodes/${n.id}/undo-complete`, { method: 'POST', body: {} }), '已撤销完成')

// ───── 分解（部门计划二次分解）─────
type SplitKey = 'drawing' | 'purchase' | 'assembly' | 'steps' | 'task'
/** 按节点责任部门给出能新建的部门记录；其他任务所有部门都能建 */
function splitItems(n: PlanNodeRow): { key: SplitKey; label: string }[] {
  const c = data.value?.canCreate
  if (!c) return []
  const items: { key: SplitKey; label: string }[] = []
  if (n.dept === 'TECH' && c.drawing) items.push({ key: 'drawing', label: '新建设计任务' })
  if (n.dept === 'PURCHASE' && c.purchase) items.push({ key: 'purchase', label: '新建采购行' })
  if (n.dept === 'PRODUCTION' && c.kitting) items.push({ key: 'assembly', label: '新建装配节点' })
  if (n.dept === 'PRODUCTION' && c.route) items.push({ key: 'steps', label: '挂工序' })
  if (n.canSplit) items.push({ key: 'task', label: '新建其他任务' })
  return items
}
/** 新建设计任务 / 采购行 / 装配节点：用各自的弹窗，预选本节点 */
const recordOpen = ref<'drawing' | 'purchase' | 'assembly' | null>(null)
const presetNode = ref<{ id: string; planDate: string } | null>(null)
function onSplit(n: PlanNodeRow, key: SplitKey) {
  presetNode.value = { id: n.id, planDate: n.planDate }
  if (key === 'task') return openTask(n, null)
  if (key === 'steps') return openSteps(n)
  recordOpen.value = key
}
async function recordSaved() {
  recordOpen.value = null
  if (presetNode.value) expanded.value = [...new Set([...expanded.value, presetNode.value.id])]
  await load()
  emit('changed')
}

// 其他任务：新建 / 编辑
const { data: master } = await useMaster()
const taskOpen = ref(false)
const taskNode = ref<PlanNodeRow | null>(null)
const taskEditing = ref<PlanTask | null>(null)
const taskForm = reactive<{ name: string; ownerId: string | undefined; planDate: Dayjs | undefined; note: string }>({ name: '', ownerId: undefined, planDate: undefined, note: '' })
function openTask(n: PlanNodeRow, t: PlanTask | null) {
  taskNode.value = n
  taskEditing.value = t
  Object.assign(taskForm, {
    name: t?.name ?? '',
    ownerId: t?.ownerId ?? undefined,
    planDate: dayjs(t?.planDate ?? n.planDate),
    note: t?.note ?? '',
  })
  taskOpen.value = true
}
/** 负责人下拉：节点责任部门的人排前面 */
const ownerOptions = computed(() =>
  [...master.value.users]
    .sort((a, b) => Number(b.businessDept === taskNode.value?.dept) - Number(a.businessDept === taskNode.value?.dept))
    .map((u) => ({ value: u.id, label: `${u.name}（${u.department}）` })),
)
const taskLate = computed(() => !!taskNode.value && !!taskForm.planDate && taskForm.planDate.format('YYYY-MM-DD') > taskNode.value.planDate)
async function saveTask() {
  const n = taskNode.value
  if (!n) return
  if (!taskForm.name.trim()) return message.warning('请填写任务名称')
  if (!taskForm.ownerId) return message.warning('请选择负责人')
  if (!taskForm.planDate) return message.warning('请选择计划完成日')
  const body = { name: taskForm.name, ownerId: taskForm.ownerId, planDate: taskForm.planDate.format('YYYY-MM-DD'), note: taskForm.note || null }
  const t = taskEditing.value
  const ok = await act(
    () => (t ? send<{ planWarning: string | null }>(`/api/plan/tasks/${t.id}`, { method: 'PATCH', body }) : send<{ planWarning: string | null }>(`/api/plan/nodes/${n.id}/tasks`, { method: 'POST', body })),
    t ? '已保存' : '已分解，负责人会收到待办',
  )
  if (ok?.planWarning) message.warning(ok.planWarning)
  if (ok) {
    taskOpen.value = false
    expanded.value = [...new Set([...expanded.value, n.id])]
  }
}
function deleteTask(t: PlanTask) {
  Modal.confirm({
    title: `删除任务"${t.name}"？`,
    content: '负责人的待办会一起作废',
    okType: 'danger',
    onOk: () => act(() => send(`/api/plan/tasks/${t.id}`, { method: 'DELETE', body: {} }), '已删除'),
  })
}
const undoTask = (t: PlanTask) => act(() => send(`/api/plan/tasks/${t.id}/undo-complete`, { method: 'POST', body: {} }), '已撤销完成，负责人会重新收到待办')

// 挂工序：同一工单的工序，已挂本节点的勾上且不能取消（改挂、取消挂靠在"工件与工序链"里改）
interface StepOpt { id: string; partName: string; processName: string; mode: string; status: string; dueDate: string | null; planNodeId: string | null; planNodeName: string | null }
const stepsOpen = ref(false)
const stepsNode = ref<PlanNodeRow | null>(null)
const stepList = ref<StepOpt[]>([])
const stepsLoading = ref(false)
const stepPicked = ref<string[]>([])
async function openSteps(n: PlanNodeRow) {
  stepsNode.value = n
  stepList.value = []
  stepPicked.value = []
  stepsOpen.value = true
  stepsLoading.value = true
  try {
    stepList.value = await get<StepOpt[]>(`/api/plan/nodes/${n.id}/steps`)
    stepPicked.value = stepList.value.filter((x) => x.planNodeId === n.id).map((x) => x.id)
  } catch (e) {
    message.error(apiError(e))
  } finally {
    stepsLoading.value = false
  }
}
const stepNew = computed(() => stepPicked.value.filter((id) => stepList.value.find((x) => x.id === id)?.planNodeId !== stepsNode.value?.id))
async function saveSteps() {
  const n = stepsNode.value
  if (!n) return
  if (!stepNew.value.length) return message.warning('请勾选要挂到这个节点的工序')
  const ok = await act(() => send<{ linked: number }>(`/api/plan/nodes/${n.id}/steps`, { method: 'POST', body: { stepIds: stepNew.value } }), (r) => `已挂 ${r.linked} 道工序`)
  if (ok) {
    stepsOpen.value = false
    expanded.value = [...new Set([...expanded.value, n.id])]
  }
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
  getCheckboxProps: (r: StepOpt) => ({ disabled: r.planNodeId === stepsNode.value?.id }),
}))

// 节点完成 / 任务完成共用一个选日期的弹窗
const taskDoing = ref<PlanTask | null>(null)
function openTaskDone(t: PlanTask) {
  doneNode.value = null
  taskDoing.value = t
  doneDate.value = dayjs()
  doneOpen.value = true
}

// ───── 表格 ─────
// 列宽按内容收紧，1440 宽屏幕不横向滚动（设计规范第 3 节）；操作列固定在右边，窄屏横向滚动时也看得到
// 阶段行：按阶段分组时插在每组前面，整行合并成一格
interface PhaseRow { id: string; isPhase: true; phase: string; count: number; done: number; start: string; end: string }
type TableRow = PlanNodeRow | PhaseRow
const isPhaseRow = (r: TableRow): r is PhaseRow => 'isPhase' in r
const tableRows = computed<TableRow[]>(() => {
  const nodes = data.value?.nodes ?? []
  if (!nodes.some((n) => n.phase)) return nodes
  const out: TableRow[] = []
  for (const [i, n] of nodes.entries()) {
    const ph = n.phase ?? null
    if (i === 0 || ph !== (nodes[i - 1]!.phase ?? null)) {
      const group: PlanNodeRow[] = []
      for (const m of nodes.slice(i)) {
        if ((m.phase ?? null) !== ph) break
        group.push(m)
      }
      const starts = group.map((m) => m.startDate ?? m.planDate).sort()
      const ends = group.map((m) => m.planDate).sort()
      out.push({ id: `phase:${n.id}`, isPhase: true, phase: ph ?? '未分阶段', count: group.length, done: group.filter((m) => m.done).length, start: starts[0]!, end: ends.at(-1)! })
    }
    out.push(n)
  }
  return out
})
const predsText = (n: PlanNodeRow) => n.preds.map((p) => `#${p.seq}`).join(' ')
const predsTitle = (n: PlanNodeRow) => [...n.preds.map((p) => `#${p.seq} ${p.name}`), ...(n.customDeps ? [] : ['（默认：上一个节点）'])].join('\n')
const view = ref<'table' | 'gantt'>('table')
const today = computed(() => dayjs().format('YYYY-MM-DD'))
function selectFromGantt(id: string) {
  view.value = 'table'
  focusNode.value = id
  expanded.value = [id]
  void nextTick(() => document.querySelector(`[data-row-key="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
}

const COLS = [
  { title: '#', dataIndex: 'seq', width: 44 },
  { title: '节点', key: 'name' },
  { title: '责任部门', dataIndex: 'deptText', width: 84 },
  { title: '前置', key: 'preds', width: 76 },
  { title: '计划', key: 'plan', width: 112 },
  { title: '预计', key: 'expected', width: 136 },
  { title: '实际完成', key: 'actual', width: 116 },
  { title: '部门确认', key: 'confirm', width: 124 },
  { title: '部门任务', key: 'tasks', width: 104 },
  { title: '', key: 'ops', width: 148, fixed: 'right' as const },
]
// 阶段行第一格合并整行，其余格隐藏
const columns = COLS.map((c, i) => ({ ...c, customCell: (r: TableRow) => (isPhaseRow(r) ? { colSpan: i === 0 ? COLS.length : 0 } : {}) }))
const taskColumns = [
  { title: '类型', dataIndex: 'kindText', width: 80 },
  { title: '记录', key: 'name' },
  { title: '日期', key: 'date', width: 200 },
  { title: '预计完成', key: 'expected', width: 110 },
  { title: '状态', key: 'status', width: 170 },
  { title: '', key: 'ops', width: 120 },
]
const rowClass = (n: TableRow) => (isPhaseRow(n) ? 'phase-row' : [n.id === focusNode.value ? 'focus-row' : '', !n.done && n.delayDays > 0 ? 'late-row' : ''].join(' '))
const levelColor = (l: string | null) => (l === 'RED' ? 'red' : l === 'YELLOW' ? 'orange' : l === 'REMIND' ? 'blue' : undefined)
const confirmColor = (s: string | null) => (s === 'CONFIRMED' ? 'green' : s === 'REJECTED' ? 'red' : s === 'PENDING' ? 'orange' : undefined)
const logColumns = [
  { title: '时间', key: 'createdAt', width: 160 },
  { title: '节点', dataIndex: 'nodeName', width: 160 },
  { title: '调整', key: 'change', width: 260 },
  { title: '原因', dataIndex: 'reason' },
  { title: '操作人', dataIndex: 'actorName', width: 100 },
]
</script>

<template>
  <UiSectionCard title="总计划" sub="节点、基线与调整记录；项目经理、项目部编制和调整，责任部门负责人确认">
    <template #extra>
      <a-space wrap>
        <a-segmented v-model:value="view" :options="[{ value: 'table', label: '表格' }, { value: 'gantt', label: '甘特图' }]" aria-label="切换表格 / 甘特图" />
        <UiRefreshButton @click="load()" />
        <template v-if="data?.canEdit">
          <template v-if="!published">
            <a-select v-model:value="templateId" placeholder="模板" style="width: 140px" :options="templates.map((t) => ({ value: t.id, label: t.name }))" />
            <a-button @click="generate">按模板生成</a-button>
          </template>
          <a-button @click="openEdit(null)">新增节点</a-button>
          <a-button v-if="!published" type="primary" :disabled="!data.nodes.length" @click="publish">发布</a-button>
        </template>
      </a-space>
    </template>

    <a-result v-if="loadError" status="error" :title="loadError" />
    <a-spin v-else-if="!data" />
    <template v-else>
      <a-descriptions :column="{ xs: 1, sm: 2, lg: 4 }" size="small" bordered class="summary">
        <a-descriptions-item label="项目">{{ data.workOrder.projectName ?? '—' }}<span class="muted">　{{ data.workOrder.customerName }}</span></a-descriptions-item>
        <a-descriptions-item label="项目经理">{{ data.workOrder.projectManagerName ?? '未设置' }}</a-descriptions-item>
        <a-descriptions-item label="状态">
          <a-tag v-if="!data.plan || !data.nodes.length" color="default">未编制</a-tag>
          <a-tag v-else-if="published" color="green">已发布</a-tag>
          <a-tag v-else color="blue">草稿</a-tag>
          <span v-if="data.plan?.templateName" class="muted">模板：{{ data.plan.templateName }}</span>
          <div v-if="published" class="muted">{{ data.plan?.publishedByName }} {{ timeText(data.plan!.publishedAt!) }} 发布</div>
        </a-descriptions-item>
        <a-descriptions-item label="未挂节点的部门记录">
          <span v-if="!data.unlinked.total" class="muted">0</span>
          <span v-else :class="{ warn: published }" :title="`设计 ${data.unlinked.drawing}，采购 ${data.unlinked.purchase}，工序 ${data.unlinked.step}，装配 ${data.unlinked.assembly}`">
            {{ data.unlinked.total }} 条（设计 {{ data.unlinked.drawing }} / 采购 {{ data.unlinked.purchase }} / 工序 {{ data.unlinked.step }} / 装配 {{ data.unlinked.assembly }}）
          </span>
        </a-descriptions-item>
        <a-descriptions-item label="合同交期">{{ data.workOrder.deliveryDate ?? '—' }}</a-descriptions-item>
        <a-descriptions-item label="预计交期">
          <span :class="{ late: (data.deliveryDelayDays ?? 0) > 0 }">{{ data.expectedDelivery ?? '—' }}</span>
        </a-descriptions-item>
        <a-descriptions-item label="拖期天数">
          <a-tag v-if="(data.deliveryDelayDays ?? 0) > 0" color="red">拖期 {{ data.deliveryDelayDays }} 天</a-tag>
          <a-tag v-if="data.planAlertLevel" color="red" title="W9 交期风险：已通知项目经理、项目部负责人、分管领导">W9 交期风险</a-tag>
          <span v-if="data.deliveryDelayDays != null && data.deliveryDelayDays <= 0" class="ok">不拖期</span>
          <span v-else-if="data.deliveryDelayDays == null" class="muted">—</span>
        </a-descriptions-item>
        <a-descriptions-item label="延误节点">
          <a-tag v-if="data.sourceNodes" color="orange" title="源头延误节点：自身就已延误（W9 只报这些）">源头 {{ data.sourceNodes }} 个</a-tag>
          <span v-if="data.delayedNodes > data.sourceNodes" class="muted">另 {{ data.delayedNodes - data.sourceNodes }} 个受上游影响</span>
          <span v-if="!data.delayedNodes" class="muted">0</span>
        </a-descriptions-item>
      </a-descriptions>

      <a-alert
        v-if="!published && data.nodes.length"
        type="info"
        show-icon
        class="tip"
        message="草稿：调整好后点“发布”。发布前改日期不用写原因，部门记录也可以先挂上来。"
      />
      <a-alert
        v-if="data.dangling.length"
        type="warning"
        show-icon
        class="tip"
        :message="`${data.dangling.map((n) => `#${n.seq} ${n.name}`).join('、')} 后面没有节点接着：它们晚了不会推迟预计交期。如果交付要等它们，请把它们加进后续节点的“前置节点”。`"
      />

      <PlanGantt v-if="view === 'gantt'" :nodes="data.nodes" :delivery-date="data.workOrder.deliveryDate" :today="today" @select="selectFromGantt" />

      <a-table
        v-else
        v-model:expanded-row-keys="expanded"
        :columns="columns"
        :data-source="tableRows"
        :loading="loading"
        row-key="id"
        size="small"
        :pagination="false"
        :row-class-name="(r: TableRow) => rowClass(r)"
        :row-expandable="(r: TableRow) => !isPhaseRow(r)"
        :scroll="{ x: 1080 }"
      >
        <template #emptyText><a-empty :description="data.canEdit ? '还没有节点：选模板“按模板生成”，或“新增节点”' : '还没有编制总计划'" /></template>
        <template #bodyCell="{ column, record }">
          <template v-if="isPhaseRow(record as TableRow)">
            <template v-if="column.dataIndex === 'seq'">
              <span class="phase-name">{{ record.phase }}</span>
              <span class="muted">　{{ record.count }} 个节点 · {{ record.start }} ~ {{ record.end }} · 完成 {{ record.done }}/{{ record.count }}</span>
            </template>
          </template>
          <template v-else-if="column.key === 'name'">
            {{ record.name }}
            <a-tag v-if="record.alertLevel" :color="levelColor(record.alertLevel)">W9 {{ record.alertLevel === 'RED' ? '红' : '黄' }}</a-tag>
            <div v-if="record.note" class="muted">{{ record.note }}</div>
          </template>
          <template v-else-if="column.key === 'preds'">
            <span v-if="!record.preds.length" class="muted">{{ record.customDeps ? '无' : '—' }}</span>
            <span v-else :class="{ muted: !record.customDeps }" :title="predsTitle(record as PlanNodeRow)">
              {{ predsText(record as PlanNodeRow) }}
            </span>
          </template>
          <template v-else-if="column.key === 'plan'">
            {{ record.planDate }}
            <div v-if="record.startDate" class="muted">开始 {{ record.startDate }}</div>
            <div v-if="record.baselineDate && record.baselineDate !== record.planDate" class="muted">基线 <span class="changed">{{ record.baselineDate }}</span></div>
            <div v-else-if="published && !record.baselineDate" class="muted">发布后新增</div>
          </template>
          <template v-else-if="column.key === 'expected'">
            <template v-if="record.done"><span class="muted">—</span></template>
            <template v-else>
              <span :class="{ late: record.delayDays > 0 }">{{ record.expectedDate }}</span>
              <div v-if="record.delayDays > 0" class="late small">晚 {{ record.delayDays }} 天<template v-if="record.source && DRIVER_TEXT[record.driver] && record.driver !== 'prev'">（{{ DRIVER_TEXT[record.driver] }}）</template></div>
              <div v-if="record.source && record.upstream" class="late small">其中自身晚 {{ record.selfDelayDays }} 天</div>
              <a-tag v-if="record.upstream && !record.source" color="default" class="small" :title="record.pushedBy ? `被 #${record.pushedBy.seq} ${record.pushedBy.name} 推后` : ''">受上游影响<template v-if="record.pushedBy">（#{{ record.pushedBy.seq }}）</template></a-tag>
              <div v-if="record.slackDays != null">
                <UiStatusTag v-if="record.critical" tone="primary">关键</UiStatusTag>
                <span v-else class="muted">余量 {{ record.slackDays }} 天</span>
              </div>
            </template>
          </template>
          <template v-else-if="column.key === 'actual'">
            <template v-if="record.done">
              <span :class="{ late: record.actualDate > record.planDate }">{{ record.actualDate }}</span>
              <div class="muted">{{ record.doneBy === 'MANUAL' ? `${record.manualDoneByName ?? ''} 手动标记` : '挂靠任务全部完成' }}</div>
            </template>
            <span v-else class="muted">未完成</span>
          </template>
          <template v-else-if="column.key === 'confirm'">
            <span v-if="!record.confirmStatus" class="muted">{{ published ? '—' : '发布后确认' }}</span>
            <template v-else>
              <a-tag :color="confirmColor(record.confirmStatus)">{{ record.confirmText }}</a-tag>
              <a-tag v-if="record.confirmAlertLevel" :color="levelColor(record.confirmAlertLevel)">超时</a-tag>
              <div v-if="record.confirmedByName && record.confirmStatus !== 'PENDING'" class="muted">{{ record.confirmedByName }}</div>
              <div v-if="record.confirmStatus === 'REJECTED' && record.rejectReason" class="late small">{{ record.rejectReason }}</div>
            </template>
          </template>
          <template v-else-if="column.key === 'tasks'">
            <template v-if="!record.taskCount">
              <UiStatusTag v-if="published && !record.done" :tone="record.splitAlertLevel ? 'late' : 'risk'">未分解</UiStatusTag>
              <span v-else class="muted">0</span>
            </template>
            <template v-else>
              {{ record.doneCount }}/{{ record.taskCount }} 完成
              <div v-if="record.overdueCount" class="late small">逾期 {{ record.overdueCount }}</div>
              <div v-if="record.lateCount" class="late small">晚于节点 {{ record.lateCount }}</div>
            </template>
            <a-dropdown v-if="splitItems(record as PlanNodeRow).length" :trigger="['click']">
              <a-button type="link" size="small" class="split-btn">+ 分解</a-button>
              <template #overlay>
                <a-menu>
                  <a-menu-item v-for="it in splitItems(record as PlanNodeRow)" :key="it.key" @click="onSplit(record as PlanNodeRow, it.key)">{{ it.label }}</a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
          </template>
          <template v-else-if="column.key === 'ops'">
            <a-space wrap size="small">
              <template v-if="record.canConfirm && record.confirmStatus === 'PENDING'">
                <a-button size="small" type="primary" @click="confirmNode(record as PlanNodeRow)">确认</a-button>
                <a-button size="small" danger @click="askReason('reject', record as PlanNodeRow)">退回</a-button>
              </template>
              <a-button v-if="record.canComplete && !record.done" size="small" @click="openDone(record as PlanNodeRow)">标完成</a-button>
              <a-button v-if="record.canComplete && record.doneBy === 'MANUAL'" size="small" @click="undoDone(record as PlanNodeRow)">撤销完成</a-button>
              <template v-if="data.canEdit">
                <a-button size="small" @click="openEdit(record as PlanNodeRow)">调整</a-button>
                <a-button size="small" danger @click="askReason('delete', record as PlanNodeRow)">删除</a-button>
              </template>
            </a-space>
          </template>
        </template>
        <template #expandedRowRender="{ record }">
          <a-empty v-if="!record.tasks.length" :description="splitItems(record as PlanNodeRow).length ? '还没有分解：点本行“部门任务”列的“+ 分解”新建' : '还没有分解：等责任部门在这里新建部门任务'" />
          <a-table v-else :columns="taskColumns" :data-source="record.tasks" :row-key="(t: PlanTask) => `${t.kind}:${t.id}`" size="small" :pagination="false">
            <template #bodyCell="{ column: c, record: t }">
              <template v-if="c.key === 'name'">
                <template v-if="t.kind === 'task'">
                  {{ t.name }}
                  <div v-if="t.note" class="muted">{{ t.note }}</div>
                </template>
                <NuxtLink v-else :to="t.link">{{ t.name }}</NuxtLink>
              </template>
              <template v-else-if="c.key === 'date'">
                <span :class="{ late: t.lateForNode && !t.done }">{{ t.dateLabel }} {{ t.planDate ?? '未填' }}</span>
                <a-tag v-if="t.lateForNode && !t.done && !t.excluded" color="red">晚于节点</a-tag>
              </template>
              <template v-else-if="c.key === 'expected'">
                <span v-if="t.excluded" class="muted">不计</span>
                <span v-else-if="t.done">{{ t.doneDate }}</span>
                <span v-else :class="{ late: t.overdue }">{{ t.expectedDate ?? '—' }}</span>
              </template>
              <template v-else-if="c.key === 'status'">
                {{ t.statusText }}
                <a-tag v-if="t.overdue" color="red">逾期</a-tag>
              </template>
              <template v-else-if="c.key === 'ops'">
                <a-space v-if="t.kind === 'task'" :size="0" wrap>
                  <a-button v-if="t.canDone && !t.done" type="link" size="small" @click="openTaskDone(t as PlanTask)">完成</a-button>
                  <a-button v-if="t.canDone && t.done" type="link" size="small" @click="undoTask(t as PlanTask)">撤销完成</a-button>
                  <a-button v-if="t.canEdit" type="link" size="small" @click="openTask(record as PlanNodeRow, t as PlanTask)">修改</a-button>
                  <a-button v-if="t.canEdit" type="link" size="small" danger @click="deleteTask(t as PlanTask)">删除</a-button>
                </a-space>
              </template>
            </template>
          </a-table>
        </template>
      </a-table>

      <h4 class="section">调整记录（发布后）</h4>
      <a-table :columns="logColumns" :data-source="data.changeLogs" row-key="id" size="small" :pagination="{ pageSize: 10, hideOnSinglePage: true }">
        <template #emptyText><a-empty description="没有调整" /></template>
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'createdAt'">{{ timeText(record.createdAt) }}</template>
          <template v-else-if="column.key === 'change'">
            <a-tag>{{ LOG_KIND[record.kind as keyof typeof LOG_KIND] }}</a-tag>
            <template v-if="record.kind === 'DATE'">{{ record.oldDate }} → {{ record.newDate }}</template>
            <template v-else-if="record.kind === 'ADD'">计划 {{ record.newDate }}</template>
            <template v-else>原计划 {{ record.oldDate }}</template>
          </template>
        </template>
      </a-table>
    </template>

    <a-modal v-model:open="editOpen" :title="editing ? `调整节点：${editing.name}` : '新增节点'" @ok="saveNode">
      <a-form layout="vertical">
        <a-form-item label="节点名称" required><a-input v-model:value="form.name" :maxlength="191" /></a-form-item>
        <a-form-item label="责任部门" required>
          <a-select v-model:value="form.dept" :options="DEPTS" />
          <div v-if="published && editing && form.dept !== editing.dept" class="muted">改责任部门后会重新请新部门负责人确认</div>
        </a-form-item>
        <a-form-item label="阶段（分组显示，可不填）">
          <a-auto-complete v-model:value="form.phase" :options="phaseOptions" :maxlength="64" placeholder="如：图纸设计及文件下发、采购" />
        </a-form-item>
        <div class="date-pair">
          <a-form-item label="计划开始日（可不填）">
            <a-date-picker v-model:value="form.startDate" style="width: 100%" />
          </a-form-item>
          <a-form-item label="计划完成日" required>
            <a-date-picker v-model:value="form.planDate" style="width: 100%" />
          </a-form-item>
        </div>
        <div v-if="startLate" class="late small form-tip">计划开始日晚于计划完成日</div>
        <div v-if="editing?.baselineDate" class="muted form-tip">基线 {{ editing.baselineDate }}</div>
        <a-form-item label="前置节点（等它们完成才能开始；它们晚了，本节点跟着往后推）">
          <a-radio-group v-model:value="form.depMode">
            <a-radio value="default">默认：上一个节点（{{ defaultPredText }}）</a-radio>
            <a-radio value="custom">自己选</a-radio>
          </a-radio-group>
          <a-select
            v-if="form.depMode === 'custom'"
            v-model:value="form.preds"
            mode="multiple"
            :options="predOptions"
            option-filter-prop="label"
            placeholder="不选 = 没有前置（和别的节点并行开始）"
            style="width: 100%; margin-top: 8px"
          />
          <div v-if="form.depMode === 'custom'" class="muted">填了开始日时，前置节点晚到开始日前一天之前都不影响本节点（中间的空档是余量）。</div>
        </a-form-item>
        <a-form-item label="顺序号（小的在前，不填排最后）"><a-input-number v-model:value="form.seq" :precision="0" style="width: 100%" /></a-form-item>
        <a-form-item label="备注"><a-input v-model:value="form.note" :maxlength="500" /></a-form-item>
        <a-form-item v-if="needReason" label="调整原因（已发布，必填；会记入调整记录并重新请部门确认）" required>
          <a-textarea v-model:value="form.reason" :rows="2" :maxlength="500" />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal v-model:open="reasonOpen" :title="reasonFor?.kind === 'reject' ? `退回节点：${reasonFor?.node.name}` : `删除节点：${reasonFor?.node.name}`" @ok="submitReason">
      <p class="muted">{{ reasonFor?.kind === 'reject' ? '退回后项目经理会收到提醒，调整日期后会重新请你确认。' : '总计划已发布，删除要写原因（记入调整记录）；挂在上面的部门记录变成未挂。' }}</p>
      <a-textarea v-model:value="reasonText" :rows="3" :maxlength="500" :placeholder="reasonFor?.kind === 'reject' ? '退回原因' : '删除原因'" />
    </a-modal>

    <a-modal v-model:open="doneOpen" :title="`标记完成：${doneNode?.name ?? taskDoing?.name}`" @ok="submitDone">
      <a-form layout="vertical">
        <a-form-item label="完成日期"><a-date-picker v-model:value="doneDate" :allow-clear="false" style="width: 100%" /></a-form-item>
      </a-form>
      <p class="muted">{{ doneNode ? '部门任务全部完成时节点会自动算完成，不用手动标。' : '完成后负责人的待办关闭；节点下的部门任务全部完成时节点自动完成。' }}</p>
    </a-modal>

    <a-modal v-model:open="taskOpen" :title="taskEditing ? `改任务：${taskEditing.name}` : `分解节点：${taskNode?.name}`" @ok="saveTask">
      <p v-if="!taskEditing" class="muted">设计任务、采购行、工序、装配节点请用“分解”里对应的选项；这里建它们覆盖不到的工作（如合同评审、BOM 编制、调试、出厂检验、发运准备）。</p>
      <a-form layout="vertical">
        <a-form-item label="任务名称" required><a-input v-model:value="taskForm.name" :maxlength="191" placeholder="如：BOM 编制" /></a-form-item>
        <a-form-item label="负责人（会收到待办）" required>
          <a-select v-model:value="taskForm.ownerId" show-search option-filter-prop="label" :options="ownerOptions" placeholder="选择负责人" />
        </a-form-item>
        <a-form-item label="计划完成日" required>
          <a-date-picker v-model:value="taskForm.planDate" :allow-clear="false" style="width: 100%" />
          <div v-if="taskLate" class="late small">晚于节点计划日 {{ taskNode?.planDate }}，可以保存，总计划里会标红</div>
        </a-form-item>
        <a-form-item label="备注"><a-input v-model:value="taskForm.note" :maxlength="500" /></a-form-item>
      </a-form>
    </a-modal>

    <a-modal v-model:open="stepsOpen" :title="`挂工序到节点：${stepsNode?.name}`" :width="760" :ok-text="stepNew.length ? `挂 ${stepNew.length} 道` : '挂上'" @ok="saveSteps">
      <p class="muted">勾选这个工单里要算在本节点下的工序；已挂在别的节点的会改挂过来。取消挂靠请到“工件与工序链”里改。</p>
      <a-table
        class="ft-table"
        :columns="stepColumns"
        :data-source="stepList"
        :loading="stepsLoading"
        :row-selection="stepSelection"
        row-key="id"
        size="small"
        :pagination="false"
        :scroll="{ y: 400 }"
      >
        <template #emptyText><a-empty description="这个工单还没有工序（先在“工件与工序链”里建工件和工序）" /></template>
        <template #bodyCell="{ column: c, record: r }">
          <template v-if="c.key === 'due'">
            <span :class="{ late: !!r.dueDate && !!stepsNode && r.dueDate > stepsNode.planDate }">{{ r.dueDate ?? '未填' }}</span>
          </template>
          <template v-else-if="c.key === 'node'">
            <span v-if="r.planNodeId === stepsNode?.id" class="ok">本节点</span>
            <span v-else-if="r.planNodeName">{{ r.planNodeName }}</span>
            <span v-else class="muted">未挂</span>
          </template>
        </template>
      </a-table>
    </a-modal>

    <DrawingEditModal :open="recordOpen === 'drawing'" :task="null" :work-order-number="wo" :preset-node="presetNode" @close="recordOpen = null" @done="recordSaved" />
    <PurchaseEditModal :open="recordOpen === 'purchase'" :line="null" :work-order-number="wo" :preset-node="presetNode" @close="recordOpen = null" @done="recordSaved" />
    <KittingNodeModal :open="recordOpen === 'assembly'" :node="null" :work-order-number="wo" :preset-node="presetNode" @close="recordOpen = null" @done="recordSaved" />
  </UiSectionCard>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
.small { font-size: 12px; }
.late { color: var(--ft-late); }
.warn { color: var(--ft-upstream); }
.ok { color: var(--ft-done-text); }
.changed { text-decoration: line-through; color: var(--ft-text-3); }
.summary { margin-bottom: 12px; }
.tip { margin-bottom: 12px; }
.section { margin: 20px 0 8px; }
.split-btn { display: block; padding: 0; height: auto; margin-top: 2px; }
:deep(.late-row) td:first-child { box-shadow: inset 3px 0 0 var(--ft-late); }
:deep(.focus-row) td { background: var(--ft-risk-bg) !important; }
:deep(.phase-row) td { background: var(--ft-fill) !important; }
.phase-name { font-weight: 600; color: var(--ft-text); }
.date-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-tip { margin: -16px 0 16px; }
</style>
