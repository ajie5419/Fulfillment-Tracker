<script setup lang="ts">
/**
 * 工艺（工艺模块 10-27，zhao 定）：按部件（设计任务）跟踪料单、工艺两个状态。
 *   料单：未开始 → 编制中 → 已下发；已下发后要改先点"修改"（修改中），改完再下发。设计变更涉及已下发的料单时系统自动改成"修改中"。
 *   工艺：无 → 编制中 → 已下发；已下发后要改点"修改"回到编制中。
 * 只有工艺部、管理员能改（后端同样拦），其他人只读；下发时可以顺手建一张"工艺文件"发放单让车间签收（可选）。
 * 地址栏 ?wo= 预选工单、?view= 选视图（设计变更提醒跳过来是 view=revising），页面没离开时改了地址栏也同步回筛选（规范第 4 节第 7 条）。
 */
import { distinctPlanNodes, groupByWorkOrder, groupProgress } from '#shared/workbench'
import { processReleaseBlockReason } from '#shared/process'

const route = useRoute()
const router = useRouter()
const { data: workOrders } = await useWorkOrders()
const { data: me } = await useMe()
const canEdit = computed(() => canDo(me.value, 'processDoc'))

const VIEWS = [
  { value: 'todo', label: '未完成' },
  { value: 'drafting', label: '编制中' },
  { value: 'revising', label: '修改中' },
  { value: 'issued', label: '已下发' },
  { value: 'all', label: '全部' },
] as const
/** 只由统计卡套用的视图：图纸已发、料单未开始 */
const CARD_VIEWS = ['waiting']
const viewOf = (v: unknown) => (VIEWS.some((x) => x.value === v) || CARD_VIEWS.includes(v as string) ? (v as string) : 'todo')
const filter = reactive({
  workOrderNumber: (route.query.wo as string) || undefined,
  view: viewOf(route.query.view),
  q: '',
})
const keyword = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
watch(keyword, (v) => {
  clearTimeout(timer)
  timer = setTimeout(() => (filter.q = v.trim()), 300)
})
watch(
  () => [filter.workOrderNumber, filter.view],
  () => router.replace({ query: { ...route.query, wo: filter.workOrderNumber || undefined, view: filter.view } }),
)
// 地址栏 → 筛选（点提醒、全局搜索跳到本页时页面不会重建）
watch(
  () => [route.query.wo, route.query.view],
  ([wo, view]) => {
    if (((wo as string) || undefined) !== filter.workOrderNumber) filter.workOrderNumber = (wo as string) || undefined
    if (view !== undefined && viewOf(view) !== filter.view) filter.view = viewOf(view)
  },
)

const { data, pending, error, refresh } = await useFetch('/api/process', {
  query: computed(() => ({ workOrderNumber: filter.workOrderNumber, view: filter.view, q: filter.q || undefined })),
  default: () => ({ rows: [] as ProcessRow[], total: 0, stats: null as ProcessStats | null }),
})
const rows = computed(() => data.value.rows as ProcessRow[])
const stats = computed(() => data.value.stats as ProcessStats | null)
/** 加载失败时统计显示"—"，不显示 0（规范第 4 节第 8 条） */
const num = (n: number | undefined) => (error.value || n === undefined ? '—' : n)

const applyView = (view: string) => (filter.view = filter.view === view ? 'todo' : view)
const layout = useListLayout()
const tables = computed(() =>
  layout.value === 'group' ? groupByWorkOrder(rows.value).map((g) => ({ key: g.workOrderNumber, ...g })) : [{ key: '__all', workOrderNumber: '', rows: rows.value }],
)
const issuedOf = (g: { rows: ProcessRow[] }) => groupProgress(g.rows, (r) => r.materialStatus === 'ISSUED')
const emptyText = computed(() => (filter.view === 'todo' ? '料单、工艺都已下发，没有要做的' : '没有记录'))

// ───── 改状态 ─────
const busy = ref(false)
/** 下发 / 修改：弹窗填备注（修改原因）；下发时可勾"同时建发放单" */
const acting = ref<{ row: ProcessRow; kind: ProcessKind; action: 'issue' | 'revise' } | null>(null)
const actNote = ref('')
const withRelease = ref(false)
function act(row: ProcessRow, kind: ProcessKind, action: ProcessAction) {
  const reason = processReleaseBlockReason(kind, action, !!row.drawingRelease)
  if (reason) { message.warning(reason); return }
  if (action === 'issue' || action === 'revise') {
    acting.value = { row, kind, action }
    actNote.value = ''
    withRelease.value = false
    return
  }
  if (action === 'reset') {
    Modal.confirm({
      title: `撤回${PROCESS_KIND_TEXT[kind]}：${row.componentName}？`,
      content: kind === 'MATERIAL' ? '回到"未开始"' : '回到"无"',
      okText: '撤回',
      onOk: () => send(row, kind, action),
    })
    return
  }
  send(row, kind, action)
}
async function send(row: ProcessRow, kind: ProcessKind, action: ProcessAction, note?: string) {
  busy.value = true
  try {
    const r = await processAction(row.id, { kind, action, note: note || null })
    message.success(`${row.componentName}：${PROCESS_KIND_TEXT[kind]}现在是"${r.statusText}"`)
    await refresh()
    return true
  } catch (e) {
    message.error(apiError(e))
    await refresh()
    return false
  } finally {
    busy.value = false
  }
}
async function submitAct() {
  const a = acting.value
  if (!a) return
  const ok = await send(a.row, a.kind, a.action, actNote.value.trim())
  if (!ok) return
  acting.value = null
  if (a.action === 'issue' && withRelease.value) openRelease(a.row, a.kind)
}

// ───── 顺手建发放单（工艺文件）─────
const prefill = ref<ReleasePrefill | null>(null)
const releaseOpen = ref(false)
function openRelease(row: ProcessRow, kind: ProcessKind) {
  prefill.value = processReleasePrefill(row, kind)
  releaseOpen.value = true
}

// ───── 变更记录 ─────
const logOf = ref<ProcessRow | null>(null)
const logs = ref<ProcessLog[]>([])
const logLoading = ref(false)
const logError = ref('')
async function openLogs(row: ProcessRow) {
  logOf.value = row
  logs.value = []
  logError.value = ''
  logLoading.value = true
  try {
    logs.value = (await fetchProcessLogs(row.id)).logs
  } catch (e) {
    logError.value = apiError(e)
  } finally {
    logLoading.value = false
  }
}
const logTone = (l: ProcessLog) => (l.toText === '修改中' ? 'late' : l.toText === '已下发' ? 'done' : l.toText === '编制中' ? 'primary' : 'none')

const columns = [
  { title: '工单', key: 'wo', width: 120 },
  { title: '总计划节点', key: 'planNode', width: 104 },
  { title: '部件 / 关联工件', key: 'component', width: 200 },
  { title: '设计', key: 'drawing', width: 130 },
  { title: '料单', key: 'material', width: 220 },
  { title: '工艺', key: 'process', width: 200 },
  { title: '', key: 'logs', width: 64, fixed: 'right' as const },
]
const sumWidth = (cols: { width: number }[]) => cols.reduce((n, c) => n + c.width, 0)
const groupColumns = columns.filter((c) => c.key !== 'wo')
const tableWidth = sumWidth(columns)
const groupWidth = sumWidth(groupColumns)
const partNames = (r: ProcessRow) => partsText(r.parts.map((p) => p.name))
const whoWhen = (name: string | null, at: string | null) => (name && at ? `${name} ${timeText(at).slice(5, 16)}` : '')
</script>

<template>
  <div>
  <div class="ft-page">
  <div class="ft-stats">
    <UiStatCard label="图纸已发、料单未开始" :value="num(stats?.waiting)" unit="个部件" tone="risk" accent icon="warn" clickable :active="filter.view === 'waiting'" sub="图纸已经发放，料单还没开始编" @click="applyView('waiting')" />
    <UiStatCard label="料单编制中" :value="num(stats?.drafting)" unit="个部件" tone="primary" accent icon="dot" clickable :active="filter.view === 'drafting'" @click="applyView('drafting')">
      <template #sub>工艺编制中 {{ num(stats?.processDrafting) }}</template>
    </UiStatCard>
    <UiStatCard label="料单 / 工艺修改中" :value="num(stats?.revising)" unit="个部件" tone="late" accent icon="alert" clickable :active="filter.view === 'revising'" sub="已下发后要改，含设计变更、发放单作废" @click="applyView('revising')" />
    <UiStatCard label="料单已下发" :value="num(stats?.materialIssued)" unit="个部件" tone="done" accent icon="check" clickable :active="filter.view === 'issued'" @click="applyView('issued')">
      <template #sub>工艺已下发 {{ num(stats?.processIssued) }} · 共 {{ num(stats?.total) }} 个部件</template>
    </UiStatCard>
  </div>
  <a-card>
    <template #title>
      <span class="ft-title">工艺
        <UiHelpTip label="工艺说明">按部件（设计任务）跟踪料单和工艺。图纸正式发放后才可开始编制、下发，不要求签收；发放单作废时，已下发的料单和工艺自动转为"修改中"。料单：未开始 → 编制中 → 已下发，已下发后要改先点"修改料单"，改完再下发；技术部发设计变更时，涉及的部件料单已下发的会自动改成"修改中"并提醒工艺部负责人。工艺：无 → 编制中 → 已下发。只有工艺部可以改，其他人只读。下发时可以顺手建一张工艺文件发放单，让车间签收。</UiHelpTip>
      </span>
    </template>
    <template #extra>
      <a-space wrap>
        <a-select
          v-model:value="filter.workOrderNumber"
          allow-clear
          show-search
          placeholder="全部工单"
          style="width: 170px"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: w.workOrderNumber }))"
        />
        <UiRefreshButton @click="refresh()" />
      </a-space>
    </template>

    <div class="ft-toolbar">
      <a-segmented v-model:value="filter.view" :options="VIEWS.map((v) => ({ value: v.value, label: v.label }))" />
      <div class="ft-toolbar-right">
        <a-input-search v-model:value="keyword" allow-clear placeholder="部件 / 工单" style="width: 180px" />
        <a-segmented v-model:value="layout" :options="LAYOUT_OPTIONS" />
      </div>
    </div>
    <p v-if="filter.view === 'waiting'" class="muted">只看图纸已经发放、料单还没开始的部件。<a @click="applyView('waiting')">看全部未完成</a></p>
    <p v-if="data.total > rows.length" class="warn">共 {{ data.total }} 个部件，只显示前 {{ rows.length }} 个，请按工单筛选</p>
    <p v-if="!canEdit" class="muted">只读：只有工艺部或管理员可以改料单、工艺状态。</p>

    <a-result v-if="error" status="error" title="加载失败" :sub-title="apiError(error)">
      <template #extra><a-button @click="refresh()">重试</a-button></template>
    </a-result>
    <template v-else>
    <a-spin v-if="layout === 'group' && !rows.length" :spinning="pending"><a-empty :description="emptyText" /></a-spin>
    <div v-for="t in tables" :key="t.key" :class="{ 'ft-wo-group': layout === 'group' }">
    <UiWoGroupHead v-if="layout === 'group'" :no="t.workOrderNumber" :nodes="distinctPlanNodes(t.rows)" v-bind="issuedOf(t)" label="料单已下发" :count="t.rows.length" unit="个部件" />
    <a-table
      class="ft-table"
      :columns="layout === 'group' ? groupColumns : columns"
      :data-source="t.rows"
      :loading="pending"
      row-key="id"
      size="small"
      :scroll="{ x: layout === 'group' ? groupWidth : tableWidth }"
      :pagination="layout === 'group' ? false : { pageSize: 50, hideOnSinglePage: true }"
    >
      <template #emptyText><a-empty :description="emptyText" /></template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'component'">
          {{ record.componentName }}
          <div class="muted">{{ record.parts.length ? partNames(record as ProcessRow) : '未关联工件' }}</div>
        </template>
        <template v-else-if="column.key === 'wo'"><WoLink :no="record.workOrderNumber" /></template>
        <template v-else-if="column.key === 'planNode'"><PlanNodeCell :work-order-number="record.workOrderNumber" :node="record.planNode" /></template>
        <template v-else-if="column.key === 'drawing'">
          <NuxtLink :to="`/drawings?id=${encodeURIComponent(record.id)}`">{{ record.drawingStatusText }}</NuxtLink>
          <div v-if="record.drawingRelease" class="muted">图纸已发 <NuxtLink :to="`/releases?id=${encodeURIComponent(record.drawingRelease.id)}`">{{ record.drawingRelease.releaseNo }}</NuxtLink></div>
          <div v-else class="muted">图纸未发放</div>
        </template>
        <template v-else-if="column.key === 'material' || column.key === 'process'">
          <template v-for="kind in [column.key === 'material' ? 'MATERIAL' : 'PROCESS'] as ProcessKind[]" :key="kind">
            <UiStatusTag v-if="kind === 'MATERIAL'" :tone="MATERIAL_TONE[record.materialStatus as MaterialStatusKey]">{{ record.materialStatusText }}</UiStatusTag>
            <UiStatusTag v-else :tone="PROCESS_TONE[record.processStatus as ProcessStatusKey]">{{ record.processStatusText }}</UiStatusTag>
            <div class="muted">{{ kind === 'MATERIAL' ? whoWhen(record.materialByName, record.materialAt) : whoWhen(record.processByName, record.processAt) }}</div>
            <a-space v-if="(kind === 'MATERIAL' ? record.actions.material : record.actions.process).length" size="small" wrap class="acts">
              <a-button
                v-for="a in (kind === 'MATERIAL' ? record.actions.material : record.actions.process) as ProcessAction[]"
                :key="a"
                size="small"
                :disabled="busy || !!processReleaseBlockReason(kind, a, !!record.drawingRelease)"
                :title="processReleaseBlockReason(kind, a, !!record.drawingRelease) || undefined"
                @click="act(record as ProcessRow, kind, a)"
              >{{ actionLabel(kind, a) }}</a-button>
            </a-space>
          </template>
        </template>
        <template v-else-if="column.key === 'logs'"><a-button type="link" size="small" @click="openLogs(record as ProcessRow)">记录</a-button></template>
      </template>
    </a-table>
    </div>
    </template>
  </a-card>
  </div>

  <ReleaseCreateModal :open="releaseOpen" :prefill="prefill" @close="releaseOpen = false" @done="releaseOpen = false" />

  <a-modal
    :open="!!acting"
    :title="acting ? `${actionLabel(acting.kind, acting.action)}：${acting.row.componentName}` : ''"
    :ok-text="acting?.action === 'issue' ? '下发' : acting?.kind === 'MATERIAL' ? '改为修改中' : '改回编制中'"
    :confirm-loading="busy"
    @ok="submitAct"
    @cancel="acting = null"
  >
    <a-form v-if="acting" layout="vertical">
      <p class="muted">{{ acting.row.workOrderNumber }} · {{ acting.row.drawingStatusText }}{{ acting.row.drawingRelease ? ` · 图纸已发 ${acting.row.drawingRelease.releaseNo}` : ' · 图纸还没发放' }}</p>
      <a-form-item :label="acting.action === 'revise' ? '修改原因（可选）' : '备注（可选）'">
        <a-textarea v-model:value="actNote" :maxlength="500" :auto-size="{ minRows: 2, maxRows: 4 }" :placeholder="acting.action === 'revise' ? '如：现场反馈下料尺寸不对' : '如：第一批，只含车架主梁'" />
      </a-form-item>
      <a-checkbox v-if="acting.action === 'issue'" v-model:checked="withRelease">同时建一张工艺文件发放单，让车间签收</a-checkbox>
      <p v-if="acting.action === 'revise' && acting.kind === 'MATERIAL'" class="muted">改完后再点"下发料单"。</p>
    </a-form>
  </a-modal>

  <a-drawer :open="!!logOf" width="520" :title="logOf ? `变更记录：${logOf.componentName}` : ''" @close="logOf = null">
    <a-spin :spinning="logLoading">
      <p v-if="logError" class="warn">{{ logError }} <a @click="logOf && openLogs(logOf)">重试</a></p>
      <p v-else-if="!logLoading && !logs.length" class="muted">还没有改过料单、工艺状态</p>
      <div v-else class="ft-well list">
        <UiListItem v-for="l in logs" :key="l.id" :tone="logTone(l)" compact>
          <template #title>{{ l.kindText }}：{{ l.fromText }} → {{ l.toText }}</template>
          <template #desc>
            {{ l.actorName }} · {{ timeText(l.createdAt) }}
            <template v-if="l.auto && l.release"> · 发放单 <NuxtLink :to="`/releases?id=${encodeURIComponent(l.release.id)}`">{{ l.release.releaseNo ?? '（已删除）' }}</NuxtLink> 自动回退</template>
          </template>
          <template v-if="l.note" #meta>{{ l.note }}</template>
        </UiListItem>
      </div>
    </a-spin>
  </a-drawer>
  </div>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
.warn { color: var(--ft-late); }
.acts { margin-top: 4px; }
</style>
