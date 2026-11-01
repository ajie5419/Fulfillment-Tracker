<script setup lang="ts">
import { CONFIRM_TONE } from '~/utils/plan-status'

/**
 * 总计划编辑（R14）：一个工单一份主线计划，部门记录（设计 / 采购 / 工序 / 装配节点）挂到节点上。
 * 用在"项目计划"页 /plan?wo=（zhao 10-22：一度并进工单详情的页签，测试后又单独成菜单页；旧的 /wo/:no?tab=plan 跳过来）。
 *   节点表：基线 / 当前计划 / 预计 / 实际日期、责任部门、确认状态、挂靠任务数、逾期数；展开看挂靠任务（可跳到各自页面）。
 *   10-22 按真实 MS Project 计划补：节点可设阶段（表格按阶段分组）、计划开始日、前置节点（多条线并行，只沿前置往后推），
 *     用了前置 / 开始日的计划显示余量和关键节点；"甘特图"视图（PlanGantt，只读）。
 *   顶部：合同交期、预计交期、拖期天数、未挂节点的部门记录条数。
 *   项目经理、项目部、管理员可按模板生成、增删改节点、发布（发布后改日期 / 加删节点要写原因，记调整记录）；
 *   节点完成由部门任务自动汇总。
 *   10-23 zhao："不够直观，没分成 1、2 级；部门的任务分解不应该在这个界面"——
 *     按 MS Project 大纲显示：阶段 = 1 级（灰底粗体行，可折叠），节点 = 2 级，子节点 = 3 级（再缩进，汇总行可折叠），编号 阶段.节点.子节点；
 *     接收、退回、分解都挪到"部门计划"页（/dept-plan），这里的"部门执行"列和展开行只读（任务负责人仍可标完成）。
 * 地址栏 ?node= 定位节点（W9 提醒、任务待办跳过来）。所有人可见（看不到的工单接口会拒绝；手里有接收待办的部门负责人例外，见 server/utils/auth.ts）。
 */
import dayjs, { type Dayjs } from 'dayjs'
import type { ClientResponse } from '../utils/transport'
import type { BusinessDeptCode } from '#shared/business-depts'
import { BUSINESS_DEPT_OPTIONS } from '#shared/business-depts'

import { factoryDay } from '#shared/mobile-todo'
import { isPlanStartLate, planAdjustmentNeedsReason, isPlanAdjustmentReasonMissing } from '#shared/plan-validation'
import type { PlanNodeRow } from '#shared/plan-view'

const DEPTS = BUSINESS_DEPT_OPTIONS
const DRIVER_TEXT: Record<string, string> = { self: '', task: '挂靠任务拖后', prev: '前置节点顺延', today: '计划日已过仍未完成', actual: '' }
const LOG_KIND = { DATE: '改日期', ADD: '加节点', DELETE: '删节点' } as const

const props = defineProps<{ wo: string }>()
/** 节点有变动（生成、发布、改日期、确认、完成……）时通知工单详情刷新概览 */
const emit = defineEmits<{ changed: [] }>()
const route = useRoute()
const wo = computed(() => props.wo)
const focusNode = ref<string | null>((route.query.node as string) || null)

const get = clientRequest
const send = clientRequest

const data = ref<ClientResponse<'/api/plan', 'GET'> | null>(null)
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
    data.value = await get('/api/plan', { query: { workOrderNumber: wo.value } })
    if (focusNode.value && data.value.nodes.some((n) => n.id === focusNode.value)) {
      reveal(focusNode.value)
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
  const run = () => act(() => send('/api/plan/generate', { method: 'POST', body: { workOrderNumber: wo.value, templateId: templateId.value as string } }), (r) => `已生成 ${r.created} 个节点`)
  if (!data.value?.nodes.length) return run()
  Modal.confirm({ title: '按模板重新生成？', content: '现有节点会被替换，挂在上面的部门记录变成未挂', onOk: run })
}

// ───── 发布 ─────
function publish() {
  Modal.confirm({
    title: '发布总计划？',
    content: '发布后当前计划日记为基线，各责任部门负责人在“部门计划”里接收本部门的节点、分解任务；之后改日期、加删节点都要写原因。已发布工单新建部门记录必须选所属节点。',
    onOk: () =>
      act(
        () => send('/api/plan/publish', { method: 'POST', body: { workOrderNumber: wo.value } }),
        (r) => `已发布，发出 ${r.todos} 条接收待办${r.deptsWithoutHead.length ? `（${r.deptsWithoutHead.join('、')}没有负责人，没人收到）` : ''}`,
      ),
  })
}

// ───── 新增 / 编辑节点 ─────
const editOpen = ref(false)
const editing = ref<PlanNodeRow | null>(null)
const form = reactive<{
  name: string
  dept: BusinessDeptCode
  phase: string
  startDate: Dayjs | undefined
  planDate: Dayjs | undefined
  seq: number | undefined
  /** 上级节点（子节点）；空 = 一级节点 */
  parentId: string | undefined
  /** default = 默认（一级节点等上一个一级节点，子节点没有前置）；custom = 自己选（可以不选 = 没有前置） */
  depMode: 'default' | 'custom'
  preds: string[]
  note: string
  reason: string
}>({ name: '', dept: 'PROJECT', phase: '', startDate: undefined, planDate: undefined, seq: undefined, parentId: undefined, depMode: 'default', preds: [], note: '', reason: '' })
/** 编辑节点；新增时 under = 加在哪个节点下面（子节点，责任部门、计划完成日先按上级填） */
function openEdit(n: PlanNodeRow | null, under: PlanNodeRow | null = null) {
  editing.value = n
  const last = data.value?.nodes.at(-1)
  Object.assign(form, {
    name: n?.name ?? '',
    dept: n?.dept ?? under?.dept ?? 'PROJECT',
    phase: n?.phase ?? (n ? '' : (last?.phase ?? '')),
    startDate: n?.startDate ? dayjs(n.startDate) : undefined,
    planDate: n ? dayjs(n.planDate) : under ? dayjs(under.planDate) : undefined,
    seq: n?.seq ?? undefined,
    parentId: n?.parentId ?? under?.id ?? undefined,
    depMode: n?.customDeps ? 'custom' : 'default',
    preds: n?.customDeps ? n.preds.map((p) => p.id) : [],
    note: n?.note ?? '',
    reason: '',
  })
  editOpen.value = true
}
/** 前置节点下拉：同一份计划的其他节点（不含自己的上级：上级要等子节点做完） */
const predOptions = computed(() =>
  (data.value?.nodes ?? []).filter((x) => x.id !== editing.value?.id && x.id !== form.parentId).map((x) => ({ value: x.id, label: `${x.code} ${x.name}` })),
)
const phaseOptions = computed(() => (data.value?.phases ?? []).map((v) => ({ value: v })))
/** 上级节点下拉：一级节点（不含自己）；自己下面有子节点时不能再挂到别人下面 */
const parentOptions = computed(() =>
  (data.value?.nodes ?? []).filter((x) => !x.parentId && x.id !== editing.value?.id).map((x) => ({ value: x.id, label: `${x.code} ${x.name}` })),
)
const formParent = computed(() => (data.value?.nodes ?? []).find((x) => x.id === form.parentId) ?? null)
/** 默认前置：一级节点 = 上一个一级节点；子节点 = 没有前置（和兄弟子节点同时开始） */
const defaultPredText = computed(() => {
  if (formParent.value) return '没有前置（可以和同一上级下的其他子节点同时开始）'
  const list = (data.value?.nodes ?? []).filter((x) => !x.parentId)
  if (editing.value && !editing.value.parentId) {
    const i = list.findIndex((x) => x.id === editing.value!.id)
    return i > 0 ? `${list[i - 1]!.code} ${list[i - 1]!.name}` : '无（第一个节点）'
  }
  const last = list.at(-1)
  return last ? `${last.code} ${last.name}（排在最后时）` : '无'
})
/** 汇总行（有子节点）：日期由子节点算、不设前置 */
const isSummary = computed(() => !!editing.value?.childCount)
const startLate = computed(() => isPlanStartLate(form.startDate?.isValid() ? form.startDate.format('YYYY-MM-DD') : undefined, form.planDate?.isValid() ? form.planDate.format('YYYY-MM-DD') : undefined))
/** 发布后：加节点、改计划日都要写原因 */
const needReason = computed(() => planAdjustmentNeedsReason(published.value, editing.value?.planDate ?? null, form.planDate?.format('YYYY-MM-DD')))
async function saveNode() {
  if (!form.name.trim()) return message.warning('请填写节点名称')
  if (!form.planDate) return message.warning('请选择计划日期')
  if (startLate.value) return message.warning('计划开始日不能晚于计划完成日')
  if (isPlanAdjustmentReasonMissing(needReason.value, form.reason)) return message.warning('总计划已发布，请写调整原因')
  const body = {
    name: form.name,
    dept: form.dept,
    phase: form.phase || null,
    startDate: form.startDate ? form.startDate.format('YYYY-MM-DD') : null,
    planDate: form.planDate.format('YYYY-MM-DD'),
    seq: form.seq ?? null,
    parentId: form.parentId ?? null,
    preds: form.depMode === 'custom' ? form.preds : null,
    note: form.note || null,
    reason: form.reason || null,
  }
  const ok = await act(
    () => (editing.value ? send(`/api/plan/nodes/${editing.value.id}`, { method: 'PATCH', body }) : send('/api/plan/nodes', { method: 'POST', body: { workOrderNumber: wo.value, ...body } })),
    (r) => (('reconfirm' in r && r.reconfirm) || (!editing.value && published.value) ? '已保存，已重新请责任部门接收' : '已保存'),
  )
  if (ok) editOpen.value = false
}

// ───── 删除 ─────
const reasonOpen = ref(false)
const reasonText = ref('')
const reasonFor = ref<PlanNodeRow | null>(null)
function askDelete(node: PlanNodeRow) {
  if (!published.value) {
    return Modal.confirm({
      title: `删除节点"${node.name}"？`,
      content: '挂在上面的部门记录变成未挂',
      okType: 'danger',
      onOk: () => act(() => send(`/api/plan/nodes/${node.id}`, { method: 'DELETE', body: {} }), '已删除'),
    })
  }
  reasonFor.value = node
  reasonText.value = ''
  reasonOpen.value = true
}
async function submitReason() {
  const n = reasonFor.value
  if (!n) return
  if (!reasonText.value.trim()) return message.warning('请写删除原因')
  const ok = await act(() => send(`/api/plan/nodes/${n.id}`, { method: 'DELETE', body: { reason: reasonText.value } }), '已删除')
  if (ok) reasonOpen.value = false
}

/** 展开行里任务有变动（负责人标完成 / 撤销）*/
async function onWorkChanged() {
  await load()
  emit('changed')
}

// ───── 表格 ─────
// 列宽按内容收紧，1440 宽屏幕不横向滚动（设计规范第 3 节）；操作列固定在右边，窄屏横向滚动时也看得到
// 10-23 按 MS Project 大纲分级：阶段行 = 1 级（灰底粗体，可折叠），节点 = 2 级，子节点 = 3 级；汇总行（有子节点）也可折叠
interface PhaseRow {
  id: string
  isPhase: true
  phase: string
  code: string
  count: number
  done: number
  start: string
  end: string
  /** 组内最晚的预计完成日；late = 组内有延误节点 */
  expected: string | null
  late: boolean
  /** 组内末级节点（要部门接收的）：总数、已接收、待接收 */
  leaves: number
  accepted: number
  pending: number
}
type TableRow = PlanNodeRow | PhaseRow
const isPhaseRow = (r: TableRow): r is PhaseRow => 'isPhase' in r
const hasPhase = computed(() => (data.value?.nodes ?? []).some((n) => n.phase))
/** 按阶段连续分组（节点已按大纲顺序排好，子节点跟着上级） */
const phaseGroups = computed(() => {
  const nodes = data.value?.nodes ?? []
  if (!hasPhase.value) return []
  const runs: PlanNodeRow[][] = []
  for (const [i, n] of nodes.entries()) {
    if (i === 0 || (n.phase ?? null) !== (nodes[i - 1]!.phase ?? null)) runs.push([])
    runs.at(-1)!.push(n)
  }
  return runs.map((group) => {
    const first = group[0]!
    const leaves = group.filter((m) => !m.childCount)
    const open = group.filter((m) => !m.done)
    const row: PhaseRow = {
      id: `phase:${first.id}`,
      isPhase: true,
      phase: first.phase ?? '未分阶段',
      code: first.code.split('.')[0]!,
      count: group.filter((m) => !m.parentId).length,
      done: group.filter((m) => !m.parentId && m.done).length,
      start: group.map((m) => m.startDate ?? m.planDate).sort()[0]!,
      end: group.map((m) => m.planDate).sort().at(-1)!,
      expected: open.length ? open.map((m) => m.expectedDate).sort().at(-1)! : null,
      late: open.some((m) => m.delayDays > 0),
      leaves: leaves.length,
      accepted: leaves.filter((m) => m.confirmStatus === 'CONFIRMED').length,
      pending: leaves.filter((m) => m.confirmStatus === 'PENDING').length,
    }
    return { row, nodes: group }
  })
})
/** 收起的阶段行 / 汇总行 */
const collapsed = ref<string[]>([])
const isCollapsed = (id: string) => collapsed.value.includes(id)
function toggleCollapse(id: string) {
  collapsed.value = isCollapsed(id) ? collapsed.value.filter((x) => x !== id) : [...collapsed.value, id]
}
const collapsibleIds = computed(() => [...phaseGroups.value.map((g) => g.row.id), ...(data.value?.nodes ?? []).filter((n) => n.childCount).map((n) => n.id)])
const allOpen = computed(() => !collapsed.value.length)
/** 全部展开 / 只看 1 级（收起全部阶段；没用阶段时收起全部汇总行） */
function toggleAll() {
  collapsed.value = allOpen.value ? (phaseGroups.value.length ? phaseGroups.value.map((g) => g.row.id) : collapsibleIds.value) : []
}
/** 定位某个节点：展开它所在的阶段和上级 */
function reveal(id: string) {
  const n = data.value?.nodes.find((x) => x.id === id)
  const g = phaseGroups.value.find((x) => x.nodes.some((m) => m.id === id))
  collapsed.value = collapsed.value.filter((x) => x !== g?.row.id && x !== n?.parentId)
}
const tableRows = computed<TableRow[]>(() => {
  const nodes = data.value?.nodes ?? []
  const visible = (n: PlanNodeRow) => !(n.parentId && isCollapsed(n.parentId))
  if (!phaseGroups.value.length) return nodes.filter(visible)
  return phaseGroups.value.flatMap((g) => [g.row, ...(isCollapsed(g.row.id) ? [] : g.nodes.filter(visible))])
})
/** 缩进层级：有阶段时 节点 = 2 级、子节点 = 3 级；没阶段时 节点 = 1 级、子节点 = 2 级 */
const levelOf = (n: PlanNodeRow) => (n.parentId ? 3 : 2) - (hasPhase.value ? 0 : 1)
/** 汇总行的"部门执行"：子节点接收情况 */
function childSummary(n: PlanNodeRow) {
  const kids = (data.value?.nodes ?? []).filter((x) => x.parentId === n.id)
  return { total: kids.length, accepted: kids.filter((x) => x.confirmStatus === 'CONFIRMED').length, pending: kids.filter((x) => x.confirmStatus === 'PENDING').length }
}
const affectsText = (n: PlanNodeRow) => n.affects.map((p) => `${p.code} ${p.name}`).join('、')
const predsText = (n: PlanNodeRow) => n.preds.map((p) => p.code).join(' ')
const predsTitle = (n: PlanNodeRow) =>
  [...n.preds.map((p) => `${p.code} ${p.name}`), ...(n.customDeps ? [] : ['（默认：上一个节点）'])].join('\n')
/** 受谁影响：子节点晚了 / 前置节点晚了 */
const pushedText = (n: PlanNodeRow) => (!n.pushedBy ? '受上游影响' : n.pushedBy.child ? `受子节点影响（${n.pushedBy.code} ${n.pushedBy.name}）` : `受 ${n.pushedBy.code} 影响`)
const view = ref<'table' | 'gantt'>('table')
const today = computed(() => factoryDay(new Date()))
function selectFromGantt(id: string) {
  view.value = 'table'
  focusNode.value = id
  reveal(id)
  expanded.value = [id]
  void nextTick(() => document.querySelector(`[data-row-key="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
}

const columns = [
  { title: '编号 / 节点', key: 'name', width: 280 },
  { title: '责任部门', dataIndex: 'deptText', width: 80 },
  { title: '前置', key: 'preds', width: 72 },
  { title: '计划', key: 'plan', width: 112 },
  { title: '预计 / 完成', key: 'expected', width: 140 },
  { title: '部门执行', key: 'exec', width: 180 },
  { title: '', key: 'ops', width: 148, fixed: 'right' as const },
]
const rowClass = (n: TableRow) =>
  isPhaseRow(n) ? 'phase-row' : [n.id === focusNode.value ? 'focus-row' : '', !n.done && n.delayDays > 0 ? 'late-row' : '', n.parentId ? 'child-row' : '', n.childCount ? 'summary-row' : ''].join(' ')
const levelColor = (l: string | null) => (l === 'RED' ? 'red' : l === 'YELLOW' ? 'orange' : l === 'REMIND' ? 'blue' : undefined)
const logColumns = [
  { title: '时间', key: 'createdAt', width: 160 },
  { title: '节点', dataIndex: 'nodeName', width: 160 },
  { title: '调整', key: 'change', width: 260 },
  { title: '原因', dataIndex: 'reason' },
  { title: '操作人', dataIndex: 'actorName', width: 100 },
]
</script>

<template>
  <UiSectionCard title="总计划" sub="项目经理、项目部编制、发布和调整；各部门在“部门计划”里接收本部门节点、分解任务，这里只读看执行情况">
    <template #extra>
      <a-space wrap>
        <a-segmented v-model:value="view" :options="[{ value: 'table', label: '表格' }, { value: 'gantt', label: '甘特图' }]" aria-label="切换表格 / 甘特图" />
        <a-button v-if="view === 'table' && collapsibleIds.length" @click="toggleAll">{{ allOpen ? (phaseGroups.length ? '只看阶段' : '收起子节点') : '全部展开' }}</a-button>
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
        :message="`${data.dangling.map((n) => `${n.code} ${n.name}`).join('、')} 后面没有节点接着：它们晚了不会推迟预计交期。如果交付要等它们，请把它们加进后续节点的“前置节点”。`"
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
        :scroll="{ x: 1100 }"
      >
        <template #emptyText><a-empty :description="data.canEdit ? '还没有节点：选模板“按模板生成”，或“新增节点”' : '还没有编制总计划'" /></template>
        <template #bodyCell="{ column, record }">
          <template v-if="isPhaseRow(record as TableRow)">
            <template v-if="column.key === 'name'">
              <button type="button" class="fold" :aria-expanded="!isCollapsed(record.id)" :aria-label="`${isCollapsed(record.id) ? '展开' : '收起'}阶段 ${record.phase}`" @click="toggleCollapse(record.id)">
                {{ isCollapsed(record.id) ? '▸' : '▾' }}
              </button>
              <span class="phase-line">
                <span class="code">{{ record.code }}</span><span class="phase-name">{{ record.phase }}</span>
                <span class="muted">{{ record.count }} 个节点</span>
              </span>
            </template>
            <template v-else-if="column.key === 'plan'">{{ record.start === record.end ? record.end : `${record.start.slice(5)} ~ ${record.end.slice(5)}` }}</template>
            <template v-else-if="column.key === 'expected'">
              <span v-if="record.expected" :class="{ late: record.late }">{{ record.expected }}</span>
              <UiStatusTag v-else tone="done">已完成</UiStatusTag>
            </template>
            <template v-else-if="column.key === 'exec'">
              <span v-if="published" class="muted">已接收 {{ record.accepted }}/{{ record.leaves }}<template v-if="record.pending"> · <span class="warn">{{ record.pending }} 个待接收</span></template></span>
            </template>
          </template>
          <template v-else-if="column.key === 'name'">
            <span class="node-name" :class="`lv${levelOf(record as PlanNodeRow)}`">
              <button v-if="record.childCount" type="button" class="fold" :aria-expanded="!isCollapsed(record.id)" :aria-label="`${isCollapsed(record.id) ? '展开' : '收起'}子节点`" @click="toggleCollapse(record.id)">
                {{ isCollapsed(record.id) ? '▸' : '▾' }}
              </button>
              <span class="code">{{ record.code }}</span>
              <span :class="{ 'summary-name': record.childCount }">{{ record.name }}</span>
              <span v-if="record.childCount" class="muted small">　汇总 · {{ record.childCount }} 个子节点</span>
              <a-tag v-if="record.alertLevel" :color="levelColor(record.alertLevel)">W9 {{ record.alertLevel === 'RED' ? '红' : '黄' }}</a-tag>
            </span>
            <div v-if="record.note" class="muted node-note" :class="`lv${levelOf(record as PlanNodeRow)}`">{{ record.note }}</div>
          </template>
          <template v-else-if="column.key === 'preds'">
            <span v-if="record.childCount" class="muted" title="汇总行：日期由子节点算，看子节点的前置">按子节点</span>
            <span v-else-if="!record.preds.length" class="muted">{{ record.customDeps ? '无' : '—' }}</span>
            <span v-else :class="{ muted: !record.customDeps }" :title="predsTitle(record as PlanNodeRow)">
              {{ predsText(record as PlanNodeRow) }}
            </span>
          </template>
          <template v-else-if="column.key === 'plan'">
            {{ record.planDate }}
            <div v-if="record.startDate" class="muted">开始 {{ record.startDate }}</div>
            <div v-if="record.childCount" class="muted small">子节点汇总</div>
            <div v-if="record.baselineDate && record.baselineDate !== record.planDate" class="muted">基线 <span class="changed">{{ record.baselineDate }}</span></div>
            <div v-else-if="published && !record.baselineDate" class="muted">发布后新增</div>
          </template>
          <template v-else-if="column.key === 'expected'">
            <template v-if="record.done">
              <UiStatusTag tone="done">完成 {{ record.actualDate?.slice(5) }}</UiStatusTag>
              <div class="muted" :class="{ late: record.actualDate > record.planDate }">{{ record.doneBy === 'MANUAL' ? `${record.manualDoneByName ?? ''} 手动标记` : record.childCount ? '子节点全部完成' : '任务全部完成' }}</div>
            </template>
            <template v-else>
              <span :class="{ late: record.delayDays > 0 }">{{ record.expectedDate }}</span>
              <div v-if="record.delayDays > 0" class="late small">晚 {{ record.delayDays }} 天<template v-if="record.source && DRIVER_TEXT[record.driver] && record.driver !== 'prev'">（{{ DRIVER_TEXT[record.driver] }}）</template></div>
              <div v-if="record.source && record.upstream" class="late small">其中自身晚 {{ record.selfDelayDays }} 天</div>
              <div v-if="record.source && record.affects.length" class="late small" :title="affectsText(record as PlanNodeRow)">影响后续 {{ record.affects.length }} 个节点</div>
              <a-tag v-if="record.upstream && !record.source" color="default" class="small" :title="record.pushedBy ? `被 #${record.pushedBy.code} ${record.pushedBy.name} 推后` : ''">{{ pushedText(record as PlanNodeRow) }}</a-tag>
              <div v-if="record.slackDays != null">
                <UiStatusTag v-if="record.critical" tone="primary">关键</UiStatusTag>
                <span v-else class="muted">余量 {{ record.slackDays }} 天</span>
              </div>
            </template>
          </template>
          <template v-else-if="column.key === 'exec'">
            <template v-if="record.childCount">
              <span v-if="published" class="muted">子节点已接收 {{ childSummary(record as PlanNodeRow).accepted }}/{{ childSummary(record as PlanNodeRow).total }}</span>
              <span v-else class="muted">按子节点</span>
            </template>
            <span v-else-if="!record.confirmStatus" class="muted">{{ published ? '—' : '发布后由部门接收' }}</span>
            <template v-else>
              <UiStatusTag :tone="CONFIRM_TONE[record.confirmStatus as keyof typeof CONFIRM_TONE]">{{ record.confirmText }}<template v-if="record.confirmStatus === 'CONFIRMED' && record.confirmedByName"> · {{ record.confirmedByName }}</template></UiStatusTag>
              <a-tag v-if="record.confirmAlertLevel" :color="levelColor(record.confirmAlertLevel)">超时</a-tag>
              <div v-if="record.confirmStatus === 'REJECTED' && record.rejectReason" class="late small">{{ record.confirmedByName }}：{{ record.rejectReason }}</div>
              <div v-if="record.taskCount" class="small">
                {{ record.taskCount }} 项任务 · {{ record.doneCount }}/{{ record.taskCount }} 完成
                <span v-if="record.overdueCount" class="late">· 逾期 {{ record.overdueCount }}</span>
                <span v-if="record.lateCount" class="late">· 晚于节点 {{ record.lateCount }}</span>
              </div>
              <div v-else-if="record.confirmStatus === 'CONFIRMED' && !record.done" class="small">
                <UiStatusTag :tone="record.splitAlertLevel ? 'risk' : 'none'">未分解</UiStatusTag>
              </div>
            </template>
          </template>
          <template v-else-if="column.key === 'ops'">
            <a-space wrap size="small">
              <template v-if="data.canEdit">
                <a-button size="small" @click="openEdit(record as PlanNodeRow)">调整</a-button>
                <a-button v-if="!record.parentId" size="small" @click="openEdit(null, record as PlanNodeRow)">加子节点</a-button>
                <a-button size="small" danger @click="askDelete(record as PlanNodeRow)">删除</a-button>
              </template>
            </a-space>
          </template>
        </template>
        <template #expandedRowRender="{ record }">
          <div v-if="data?.network" class="affects small">
            <template v-if="record.affects.length">晚了会影响 {{ record.affects.length }} 个节点：<span class="muted">{{ affectsText(record as PlanNodeRow) }}</span></template>
            <span v-else class="muted">晚了不影响其他节点</span>
          </div>
          <div v-if="record.childCount" class="muted">汇总行：任务挂在下面的子节点上</div>
          <PlanNodeWork v-else :node="record as PlanNodeRow" :wo="wo" :can-create="data!.canCreate" view-only @changed="onWorkChanged" />
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
          <div v-if="published && editing && form.dept !== editing.dept" class="muted">改责任部门后会重新请新部门负责人接收</div>
        </a-form-item>
        <a-form-item label="上级节点（挂在某个节点下面当子节点；上级是汇总行：日期由子节点算，子节点都完成上级才算完成）">
          <a-select
            v-model:value="form.parentId"
            :options="parentOptions"
            allow-clear
            show-search
            option-filter-prop="label"
            placeholder="不选 = 一级节点"
            :disabled="!!editing?.childCount"
            style="width: 100%"
          />
          <div v-if="editing?.childCount" class="muted">这个节点下面有 {{ editing.childCount }} 个子节点，不能再挂到别的节点下面（子节点只有一层）</div>
        </a-form-item>
        <a-form-item v-if="formParent" label="阶段">
          <span class="muted">跟上级：{{ formParent.phase ?? '未分阶段' }}</span>
        </a-form-item>
        <a-form-item v-else label="阶段（分组显示，可不填）">
          <a-auto-complete v-model:value="form.phase" :options="phaseOptions" :maxlength="64" placeholder="如：图纸设计及文件下发、采购" />
        </a-form-item>
        <a-form-item v-if="isSummary" label="计划日期">
          <span>{{ editing!.startDate ?? editing!.planDate }} ～ {{ editing!.planDate }}</span>
          <div class="muted">由子节点汇总（最早开始～最晚完成），请改子节点的日期。别的节点把它设为前置 = 等它下面的子节点全部完成。</div>
        </a-form-item>
        <div v-else class="date-pair">
          <a-form-item label="计划开始日（可不填）">
            <a-date-picker v-model:value="form.startDate" style="width: 100%" />
          </a-form-item>
          <a-form-item label="计划完成日" required>
            <a-date-picker v-model:value="form.planDate" style="width: 100%" />
          </a-form-item>
        </div>
        <div v-if="startLate" class="late small form-tip">计划开始日晚于计划完成日</div>
        <div v-if="editing?.baselineDate" class="muted form-tip">基线 {{ editing.baselineDate }}</div>
        <a-form-item v-if="!isSummary" label="前置节点（等它们完成才能开始；它们晚了，本节点跟着往后推）">
          <a-radio-group v-model:value="form.depMode">
            <a-radio value="default">默认：{{ formParent ? '' : '上一个节点（' }}{{ defaultPredText }}{{ formParent ? '' : '）' }}</a-radio>
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
        <a-form-item :label="formParent ? '顺序号（同一上级下小的在前，不填排最后）' : '顺序号（小的在前，不填排最后）'"><a-input-number v-model:value="form.seq" :precision="0" style="width: 100%" /></a-form-item>
        <a-form-item label="备注"><a-input v-model:value="form.note" :maxlength="500" /></a-form-item>
        <a-form-item v-if="needReason" label="调整原因（已发布，必填；会记入调整记录并重新请部门接收）" required>
          <a-textarea v-model:value="form.reason" :rows="2" :maxlength="500" />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal v-model:open="reasonOpen" :title="`删除节点：${reasonFor?.name}`" @ok="submitReason">
      <p class="muted">总计划已发布，删除要写原因（记入调整记录）；挂在上面的部门记录变成未挂。</p>
      <a-textarea v-model:value="reasonText" :rows="3" :maxlength="500" placeholder="删除原因" />
    </a-modal>
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
:deep(.late-row) td:first-child { box-shadow: inset 3px 0 0 var(--ft-late); }
:deep(.focus-row) td { background: var(--ft-risk-bg) !important; }
:deep(.phase-row) td { background: var(--ft-fill) !important; }
.phase-name { font-weight: 600; color: var(--ft-text); margin-right: 8px; }
.phase-line { display: inline-flex; align-items: baseline; white-space: nowrap; }
/* 大纲分级：阶段行 1 级（灰底粗体），节点 2 级，子节点 3 级（再缩进、虚线分隔）；折叠按钮占固定宽度，编号对齐 */
.fold { width: 18px; height: 18px; padding: 0; margin-right: 4px; border: 0; background: none; color: var(--ft-text-2); cursor: pointer; font-size: 14px; line-height: 18px; border-radius: 4px; }
.fold:focus-visible { outline: 2px solid var(--ft-primary); }
.code { display: inline-block; min-width: 40px; margin-right: 6px; color: var(--ft-text-2); font-variant-numeric: tabular-nums; }
:deep(.phase-row) td { font-weight: 600; }
.node-name { display: inline-flex; align-items: center; flex-wrap: wrap; }
.lv1 { padding-left: 0; }
.lv2 { padding-left: 22px; }
.lv3 { padding-left: 52px; }
.node-name:not(:has(.fold)) .code { margin-left: 22px; }
.node-note { margin-left: 62px; }
.summary-name { font-weight: 600; }
:deep(.child-row) td { border-top: 1px dashed var(--ft-border); }
.date-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-tip { margin: -16px 0 16px; }
.affects { margin: 0 0 8px; line-height: 1.6; }
</style>
