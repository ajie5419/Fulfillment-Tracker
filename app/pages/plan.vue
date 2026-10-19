<script setup lang="ts">
/**
 * 项目部总计划（R14）：一个工单一份主线计划，部门记录（出图 / 采购 / 工序 / 装配节点）挂到节点上。
 *   选工单 → 节点表：基线 / 当前计划 / 预计 / 实际日期、责任部门、确认状态、挂靠任务数、逾期数；展开看挂靠任务（可跳到各自页面）。
 *   顶部：合同交期、预计交期、拖期天数、未挂节点的部门记录条数。
 *   项目经理、项目部、管理员可按模板生成、增删改节点、发布（发布后改日期 / 加删节点要写原因，记调整记录）；
 *   责任部门负责人确认 / 退回；责任部门的人、项目经理可以手动标完成（挂靠任务全部完成也自动算完成）。
 * 地址栏 ?wo= 选工单，?node= 定位节点（W9 提醒、确认待办跳过来）。所有人可见（看不到的工单接口会拒绝）。
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
}
interface PlanNodeRow {
  id: string
  seq: number
  name: string
  dept: string
  deptText: string
  note: string | null
  planDate: string
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
  canEdit: boolean
  nodes: PlanNodeRow[]
  changeLogs: { id: string; nodeName: string; kind: 'DATE' | 'ADD' | 'DELETE'; oldDate: string | null; newDate: string | null; reason: string; actorName: string | null; createdAt: string }[]
}

const DEPTS = BUSINESS_DEPT_OPTIONS
const DRIVER_TEXT: Record<string, string> = { self: '', task: '挂靠任务拖后', prev: '前序节点顺延', today: '计划日已过仍未完成', actual: '' }
const LOG_KIND = { DATE: '改日期', ADD: '加节点', DELETE: '删节点' } as const

const route = useRoute()
const router = useRouter()
const { data: workOrders } = await useWorkOrders()
const wo = ref<string | undefined>((route.query.wo as string) || undefined)
const focusNode = ref<string | null>((route.query.node as string) || null)
watch(wo, (v) => {
  // 由地址栏（如提醒链接 ?wo=&node=）带来的工单切换不清掉 node
  if ((v || undefined) === ((route.query.wo as string) || undefined)) return
  router.replace({ query: { ...route.query, wo: v || undefined, node: undefined } })
})

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
    if (route.query.wo && route.query.wo !== wo.value) wo.value = route.query.wo as string
    else void load()
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
const form = reactive<{ name: string; dept: string; planDate: Dayjs | undefined; seq: number | undefined; note: string; reason: string }>({ name: '', dept: 'PROJECT', planDate: undefined, seq: undefined, note: '', reason: '' })
function openEdit(n: PlanNodeRow | null) {
  editing.value = n
  Object.assign(form, {
    name: n?.name ?? '',
    dept: n?.dept ?? 'PROJECT',
    planDate: n ? dayjs(n.planDate) : undefined,
    seq: n?.seq ?? undefined,
    note: n?.note ?? '',
    reason: '',
  })
  editOpen.value = true
}
/** 发布后：加节点、改计划日都要写原因 */
const needReason = computed(() => published.value && (!editing.value || (!!form.planDate && form.planDate.format('YYYY-MM-DD') !== editing.value.planDate)))
async function saveNode() {
  if (!form.name.trim()) return message.warning('请填写节点名称')
  if (!form.planDate) return message.warning('请选择计划日期')
  if (needReason.value && !form.reason.trim()) return message.warning('总计划已发布，请写调整原因')
  const body = { name: form.name, dept: form.dept, planDate: form.planDate.format('YYYY-MM-DD'), seq: form.seq ?? null, note: form.note || null, reason: form.reason || null }
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
  doneNode.value = n
  doneDate.value = dayjs()
  doneOpen.value = true
}
async function submitDone() {
  const n = doneNode.value
  if (!n) return
  const ok = await act(() => send(`/api/plan/nodes/${n.id}/complete`, { method: 'POST', body: { date: doneDate.value.format('YYYY-MM-DD') } }), '已标记完成')
  if (ok) doneOpen.value = false
}
const undoDone = (n: PlanNodeRow) => act(() => send(`/api/plan/nodes/${n.id}/undo-complete`, { method: 'POST', body: {} }), '已撤销完成')

// ───── 表格 ─────
const columns = [
  { title: '#', dataIndex: 'seq', width: 46 },
  { title: '节点', key: 'name' },
  { title: '责任部门', dataIndex: 'deptText', width: 90 },
  { title: '基线', key: 'baseline', width: 104 },
  { title: '计划', key: 'plan', width: 104 },
  { title: '预计', key: 'expected', width: 150 },
  { title: '实际完成', key: 'actual', width: 130 },
  { title: '部门确认', key: 'confirm', width: 150 },
  { title: '挂靠任务', key: 'tasks', width: 120 },
  { title: '', key: 'ops', width: 230 },
]
const taskColumns = [
  { title: '类型', dataIndex: 'kindText', width: 80 },
  { title: '记录', key: 'name' },
  { title: '日期', key: 'date', width: 200 },
  { title: '预计完成', key: 'expected', width: 110 },
  { title: '状态', key: 'status', width: 160 },
]
const rowClass = (n: PlanNodeRow) => [n.id === focusNode.value ? 'focus-row' : '', !n.done && n.delayDays > 0 ? 'late-row' : ''].join(' ')
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
  <a-card title="总计划">
    <template #extra>
      <a-space wrap>
        <a-select
          v-model:value="wo"
          show-search
          placeholder="选择工单"
          style="width: 220px"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: w.workOrderNumber }))"
        />
        <a-button :disabled="!wo" @click="load()">刷新</a-button>
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

    <a-empty v-if="!wo" description="请选择工单" />
    <a-result v-else-if="loadError" status="error" :title="loadError" />
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
          <span v-else :class="{ warn: published }" :title="`出图 ${data.unlinked.drawing}，采购 ${data.unlinked.purchase}，工序 ${data.unlinked.step}，装配 ${data.unlinked.assembly}`">
            {{ data.unlinked.total }} 条（出图 {{ data.unlinked.drawing }} / 采购 {{ data.unlinked.purchase }} / 工序 {{ data.unlinked.step }} / 装配 {{ data.unlinked.assembly }}）
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

      <a-table
        v-model:expanded-row-keys="expanded"
        :columns="columns"
        :data-source="data.nodes"
        :loading="loading"
        row-key="id"
        size="small"
        :pagination="false"
        :row-class-name="(r: PlanNodeRow) => rowClass(r)"
        :scroll="{ x: 1300 }"
      >
        <template #emptyText><a-empty :description="data.canEdit ? '还没有节点：选模板“按模板生成”，或“新增节点”' : '还没有编制总计划'" /></template>
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            {{ record.name }}
            <a-tag v-if="record.alertLevel" :color="levelColor(record.alertLevel)">W9 {{ record.alertLevel === 'RED' ? '红' : '黄' }}</a-tag>
            <div v-if="record.note" class="muted">{{ record.note }}</div>
          </template>
          <template v-else-if="column.key === 'baseline'">
            <span v-if="record.baselineDate" :class="{ changed: record.baselineDate !== record.planDate }">{{ record.baselineDate }}</span>
            <span v-else class="muted">{{ published ? '发布后新增' : '—' }}</span>
          </template>
          <template v-else-if="column.key === 'plan'">{{ record.planDate }}</template>
          <template v-else-if="column.key === 'expected'">
            <template v-if="record.done"><span class="muted">—</span></template>
            <template v-else>
              <span :class="{ late: record.delayDays > 0 }">{{ record.expectedDate }}</span>
              <div v-if="record.delayDays > 0" class="late small">晚 {{ record.delayDays }} 天<template v-if="record.source && DRIVER_TEXT[record.driver] && record.driver !== 'prev'">（{{ DRIVER_TEXT[record.driver] }}）</template></div>
              <div v-if="record.source && record.upstream" class="late small">其中自身晚 {{ record.selfDelayDays }} 天</div>
              <a-tag v-if="record.upstream && !record.source" color="default" class="small">受上游影响</a-tag>
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
            <span v-if="!record.taskCount" class="muted">0</span>
            <template v-else>
              {{ record.doneCount }}/{{ record.taskCount }} 完成
              <div v-if="record.overdueCount" class="late small">逾期 {{ record.overdueCount }}</div>
              <div v-if="record.lateCount" class="late small">晚于节点 {{ record.lateCount }}</div>
            </template>
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
          <a-empty v-if="!record.tasks.length" description="还没有部门记录挂在这个节点上（在出图任务、采购行、工序、装配节点里选“所属总计划节点”）" />
          <a-table v-else :columns="taskColumns" :data-source="record.tasks" :row-key="(t: PlanTask) => `${t.kind}:${t.id}`" size="small" :pagination="false">
            <template #bodyCell="{ column: c, record: t }">
              <template v-if="c.key === 'name'"><NuxtLink :to="t.link">{{ t.name }}</NuxtLink></template>
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
        <a-form-item label="计划日期" required>
          <a-date-picker v-model:value="form.planDate" style="width: 100%" />
          <div v-if="editing?.baselineDate" class="muted">基线 {{ editing.baselineDate }}</div>
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

    <a-modal v-model:open="doneOpen" :title="`标记完成：${doneNode?.name}`" @ok="submitDone">
      <a-form layout="vertical">
        <a-form-item label="完成日期"><a-date-picker v-model:value="doneDate" :allow-clear="false" style="width: 100%" /></a-form-item>
      </a-form>
      <p class="muted">挂靠任务全部完成时会自动算完成，不用手动标。</p>
    </a-modal>
  </a-card>
</template>

<style scoped>
.muted { color: #999; font-size: 12px; }
.small { font-size: 12px; }
.late { color: #cf1322; }
.warn { color: #d46b08; }
.ok { color: #389e0d; }
.changed { text-decoration: line-through; color: #999; }
.summary { margin-bottom: 12px; }
.tip { margin-bottom: 12px; }
.section { margin: 20px 0 8px; }
:deep(.late-row) td:first-child { box-shadow: inset 3px 0 0 #cf1322; }
:deep(.focus-row) td { background: #fffbe6 !important; }
</style>
