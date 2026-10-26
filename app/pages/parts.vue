<script setup lang="ts">
/**
 * 工序编排（生产管理重设计第一批，zhao 10-26 确认；原"生产管理"页）：工艺部、生产经理给工件排工序——只管排，不放开工完工按钮
 * （开工、完工、发出、返厂到"生产调度""外协"或手机端）。
 *   选工单 → 每个工件一行（名称、图号、数量、压缩的工序链色块、一个最要紧的状态）→ "编排"打开右侧编排抽屉改；列表只读。
 *   勾选多个工件：批量套用模板、批量设负责人 / 班组 / 日期 / 总计划节点。
 * 权限方案 R13：建 / 改 / 删工件和工序、导入 BOM、套模板、复制路线 —— 生产部、工艺部、外协专员、该工单项目经理、管理员；其他人只读（后端同样拦）。
 * R14：每道工序可选"所属总计划节点"（工单总计划已发布时手工添加的必选）。
 * 地址栏：?wo= 工单；?noRoute=1 只看未排工序（图纸附 BOM 发放后的提醒跳过来）；?part=<工件 ID> 打开工件抽屉（全局搜索跳过来），
 *   再带 comments=1 直接打开留言（留言提醒跳过来）；?edit=<工件 ID> 打开编排抽屉（工件抽屉里点"去编排"）。
 */
import { chainTones, partHeadline, routeFilterOf, ROUTE_FILTER_TEXT, type ChainTone, type RouteFilter } from '#shared/production'
import { factoryDay } from '#shared/mobile-todo'

const route = useRoute()
const router = useRouter()
const { data: workOrders } = await useWorkOrders()
const { data: me } = await useMe()

const FILTERS: RouteFilter[] = ['all', 'none', 'fill', 'ok']
const workOrderNumber = ref<string | undefined>((route.query.wo as string) || undefined)
watch(workOrders, (list) => {
  if (!workOrderNumber.value && list.length) workOrderNumber.value = list[0]!.workOrderNumber
}, { immediate: true })
const routeFilter = ref<RouteFilter>(route.query.noRoute === '1' ? 'none' : 'all')
// 选中的工单、筛选记在地址栏（定位用的 part / comments / edit 由 useOneShotQuery 处理一次后删掉；这里照抄，免得"去编排"切工单时提前删掉 edit）
watch([workOrderNumber, routeFilter], ([wo, f]) => {
  if (import.meta.client) router.replace({ query: { ...route.query, wo: wo || undefined, noRoute: f === 'none' ? '1' : undefined } })
})
// 反过来：页面没离开时点了别的 /parts 链接（全局搜索、提醒），按新地址切工单和筛选
watch(() => [route.query.wo, route.query.noRoute], ([wo, nr]) => {
  if (typeof wo === 'string' && wo && wo !== workOrderNumber.value) workOrderNumber.value = wo
  if (nr === '1') routeFilter.value = 'none'
  else if (routeFilter.value === 'none') routeFilter.value = 'all'
})

const { data: parts, pending, refresh } = await useFetch('/api/parts', {
  query: { workOrderNumber },
  default: () => [],
  immediate: !!workOrderNumber.value,
  watch: [workOrderNumber],
})
type PartRow = (typeof parts.value)[number]
const today = factoryDay(new Date())
const filterCounts = computed(() => {
  const c: Record<RouteFilter, number> = { all: parts.value.length, none: 0, fill: 0, ok: 0 }
  for (const p of parts.value) c[routeFilterOf(p)]++
  return c
})
const filterOptions = computed(() => FILTERS.map((f) => ({ value: f, label: `${ROUTE_FILTER_TEXT[f]} ${filterCounts.value[f]}` })))
const shownParts = computed(() => (routeFilter.value === 'all' ? parts.value : parts.value.filter((p) => routeFilterOf(p) === routeFilter.value)))

const canRoute = computed(() => canDo(me.value, 'route', { workOrderNumber: workOrderNumber.value }))

// ───── 总计划节点（同一工单，整页取一次）─────
type PlanOpts = { published: boolean; nodes: { id: string; seq: number; name: string; deptText: string; planDate: string }[] }
const { data: planOpts } = await useFetch<PlanOpts>('/api/plan/options', {
  query: { workOrderNumber },
  default: () => ({ published: false, nodes: [] }),
  immediate: !!workOrderNumber.value,
  watch: [workOrderNumber],
})

// ───── 勾选、批量 ─────
const selected = ref<string[]>([])
// 换工单或切筛选就清空勾选：批量操作只作用在看得见的工件上
watch([workOrderNumber, routeFilter], () => { selected.value = [] })
const batch = reactive({ open: false, mode: 'fields' as 'template' | 'fields' })
function openBatch(mode: 'template' | 'fields') {
  Object.assign(batch, { open: true, mode })
}
async function afterBatch() {
  batch.open = false
  await refresh()
}
const rowSelection = computed(() => (canRoute.value ? { selectedRowKeys: selected.value, onChange: (keys: (string | number)[]) => (selected.value = keys as string[]) } : undefined))

// ───── 编排抽屉、工件抽屉 ─────
const editId = ref<string | null>(null)
const editPart = computed(() => parts.value.find((p) => p.id === editId.value) ?? null)
const detailId = ref<string | null>(null)
const detailTab = ref<'info' | 'comments'>('info')
function openDetail(id: string, tab: 'info' | 'comments' = 'info') {
  detailTab.value = tab
  detailId.value = id
}
/**
 * 地址栏定位（只处理一次，useOneShotQuery）：?part= 打开工件抽屉（comments=1 开留言），?edit= 打开编排抽屉；处理完一起删掉。
 * 要等这个工单的工件加载完：刚切工单（如工件抽屉"去编排"跳到别的工单）时列表还是上一个工单的，先不处理、不删
 */
useOneShotQuery(
  ['part', 'comments', 'edit'],
  () =>
    !pending.value &&
    !(typeof route.query.wo === 'string' && route.query.wo !== workOrderNumber.value) &&
    !parts.value.some((p) => p.workOrderNumber !== workOrderNumber.value),
  ({ part, comments, edit }) => {
    if (part) openDetail(part, comments === '1' ? 'comments' : 'info')
    if (edit && parts.value.some((p) => p.id === edit)) {
      routeFilter.value = 'all'
      editId.value = edit
    }
  },
)
function onDetailEdit(p: { id: string; workOrderNumber: string }) {
  detailId.value = null
  // 别的工单的工件（如从搜索、留言提醒打开）：先关详情抽屉，再切到那个工单并打开编排（?edit= 由下面的地址栏同步处理）
  if (p.workOrderNumber !== workOrderNumber.value) return navigateTo({ path: '/parts', query: { wo: p.workOrderNumber, edit: p.id } })
  editId.value = p.id
}

// ───── 新建工件、BOM ─────
const partForm = reactive({ open: false, name: '', drawingNo: '', revision: '', quantity: 1, qmsPartId: '' })
async function createPart() {
  if (!partForm.name.trim()) return message.warning('请填写工件名称')
  try {
    const p = await $fetch('/api/parts', { method: 'POST', body: { workOrderNumber: workOrderNumber.value, name: partForm.name, drawingNo: partForm.drawingNo || null, revision: partForm.revision || null, quantity: partForm.quantity, qmsPartId: partForm.qmsPartId || null } })
    message.success('已新建，接着排工序')
    partForm.open = false
    await refresh()
    editId.value = (p as { id: string }).id
  } catch (e) {
    message.error(apiError(e))
  }
}
function openCreate() {
  Object.assign(partForm, { open: true, name: '', drawingNo: '', revision: '', quantity: 1, qmsPartId: '' })
}
const bomImportOpen = ref(false)

// ───── 展示 ─────
const CHAIN_CLASS: Record<ChainTone, string> = { done: 'c-done', current: 'c-cur', late: 'c-late', blocked: 'c-late', todo: 'c-todo' }
const chainOf = (p: PartRow) => {
  const tones = chainTones(p.steps, today)
  return p.steps.map((s, i) => ({ id: s.id, text: s.mode === 'SELF' ? s.processName : `${s.processName}${s.supplierName ? ` · ${s.supplierName}` : ' · 外协'}`, cls: CHAIN_CLASS[tones[i]!], fill: s.needsFill }))
}
const columns = [
  { title: '工件', key: 'part', width: 260 },
  { title: '工序链', key: 'chain' },
  { title: '状态', key: 'status', width: 130 },
  { title: '', key: 'actions', width: 150, fixed: 'right' as const },
]
const woOptions = computed(() => workOrders.value.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? w.customerName}　交期 ${dayText(w.deliveryDate)}` })))
</script>

<template>
  <a-card>
    <template #title>
      <span class="ft-title">工序编排 <UiHelpTip>给工件排工序链：工序、方式（自制 / 厂内外协 / 厂外外协）、班组或外协厂、负责人、应开工和要求完成日、所属总计划节点。点"编排"在右侧改，勾选多个工件可批量套模板、批量设负责人 / 班组 / 日期。工件一般由技术部发放图纸时附 BOM 自动建好。开工、完工、发出在"生产调度"和"外协"做。</UiHelpTip></span>
    </template>
    <template #extra>
      <a-select v-model:value="workOrderNumber" show-search option-filter-prop="label" placeholder="选择工单" :options="woOptions" class="filter-wo" />
      <a-segmented v-if="parts.length" v-model:value="routeFilter" class="tabs-seg" :options="filterOptions" />
      <template v-if="canRoute">
        <a-button :disabled="!workOrderNumber" @click="bomImportOpen = true">从 QMS BOM 导入</a-button>
        <a-button type="primary" :disabled="!workOrderNumber" @click="openCreate">新建工件</a-button>
      </template>
      <UiRefreshButton @click="refresh()" />
    </template>

    <div v-if="selected.length" class="batch-bar">
      <span>已选 {{ selected.length }} 个工件</span>
      <a-button size="small" @click="openBatch('template')">套用模板</a-button>
      <a-button size="small" @click="openBatch('fields')">设负责人 / 班组 / 日期 / 节点</a-button>
      <a-button size="small" type="link" @click="selected = []">取消选择</a-button>
    </div>

    <a-spin :spinning="pending">
      <a-empty v-if="workOrderNumber && !parts.length" description="这个工单还没有工件：技术部发放图纸时附上 BOM 表，会按图号自动建好" />
      <a-empty v-else-if="parts.length && !shownParts.length" :description="`没有${ROUTE_FILTER_TEXT[routeFilter]}的工件`" />
      <a-table v-else-if="shownParts.length" class="ft-table" :columns="columns" :data-source="shownParts" row-key="id" size="small"  :row-selection="rowSelection" :scroll="{ x: 900 }" :pagination="shownParts.length > 50 ? { pageSize: 50, showSizeChanger: false } : false">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'part'">
            <button type="button" class="name-btn" @click="openDetail(record.id)">{{ record.name }}</button>
            <div class="muted">{{ record.drawingNo || '无图号' }}{{ record.revision ? `（${record.revision} 版）` : '' }} · {{ record.quantity }} 件</div>
          </template>
          <template v-else-if="column.key === 'chain'">
            <span v-if="!record.steps.length" class="muted">还没排工序</span>
            <span v-else class="chain">
              <template v-for="(c, i) in chainOf(record as PartRow)" :key="c.id">
                <i v-if="i" class="sep" aria-hidden="true">›</i>
                <span class="step-chip" :class="[c.cls, { fill: c.fill }]">{{ c.text }}</span>
              </template>
            </span>
          </template>
          <template v-else-if="column.key === 'status'">
            <UiStatusTag :tone="partHeadline(record as PartRow, today).tone">{{ partHeadline(record as PartRow, today).text }}</UiStatusTag>
          </template>
          <template v-else-if="column.key === 'actions'">
            <a-space>
              <a-button size="small" :type="record.steps.length ? 'default' : 'primary'" @click="editId = record.id">{{ canRoute ? '编排' : '查看工序' }}</a-button>
              <a-button size="small" type="link" @click="openDetail(record.id)">详情</a-button>
            </a-space>
          </template>
        </template>
      </a-table>
      <p v-if="shownParts.length" class="legend muted">
        工序链：<span class="step-chip c-done">已完成</span> <span class="step-chip c-cur">当前</span> <span class="step-chip c-late">超期 / 有异常</span> <span class="step-chip c-todo">未开始</span> <span class="step-chip c-todo fill">待补充</span>
      </p>
    </a-spin>
  </a-card>

  <RouteEditDrawer :part="editPart" :work-order-number="workOrderNumber ?? ''" :plan-opts="planOpts" :can-route="canRoute" @close="editId = null" @changed="refresh()" @deleted="editId = null; refresh()" />
  <RouteBatchModal :open="batch.open" :mode="batch.mode" :part-ids="selected" :plan-opts="planOpts" @close="batch.open = false" @done="afterBatch" />
  <PartDrawer :part-id="detailId" :tab="detailTab" @close="detailId = null" @changed="refresh()" @edit="onDetailEdit" />
  <BomImportModal :open="bomImportOpen" :work-order-number="workOrderNumber" @close="bomImportOpen = false" @done="bomImportOpen = false; refresh()" />

  <a-modal :open="partForm.open" title="新建工件" ok-text="保存" @ok="createPart" @cancel="partForm.open = false">
    <a-form layout="vertical">
      <a-form-item label="工件名称" required><a-input v-model:value="partForm.name" placeholder="如：主梁结构件" /></a-form-item>
      <a-form-item label="图号"><a-input v-model:value="partForm.drawingNo" /></a-form-item>
      <a-form-item label="版号"><a-input v-model:value="partForm.revision" placeholder="可空，如 A" /></a-form-item>
      <a-form-item label="数量" required><a-input-number v-model:value="partForm.quantity" :min="1" style="width: 100%" /></a-form-item>
      <a-form-item label="QMS BOM 物料 ID" extra="填了以后，QMS 报检按物料 ID 自动匹配；不填则按名称和工序匹配"><a-input v-model:value="partForm.qmsPartId" /></a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.tabs-seg { max-width: 100%; overflow-x: auto; }
/* 卡片右上角的切换和筛选：窄屏时换行、不超出卡片 */
:deep(.ant-card-extra) { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; max-width: 100%; }
.filter-wo { width: 320px; max-width: calc(100vw - 72px); }
.batch-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; padding: 8px 12px; border-radius: 10px; background: var(--ft-primary-bg); color: var(--ft-primary-text); font-size: 13px; }
.name-btn { padding: 0; border: none; background: none; color: var(--ft-primary); cursor: pointer; font: inherit; font-weight: 500; text-align: left; }
.name-btn:hover { text-decoration: underline; }
.name-btn:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; border-radius: 4px; }
.muted { color: var(--ft-text-2); font-size: 12px; }
.chain { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.sep { color: var(--ft-text-3); font-style: normal; }
.step-chip { display: inline-block; padding: 1px 8px; border-radius: 6px; font-size: 12px; line-height: 20px; white-space: nowrap; border: 1px solid transparent; }
.c-done { background: var(--ft-done-bg); color: var(--ft-done-text); }
.c-cur { background: var(--ft-primary-bg); color: var(--ft-primary-text); font-weight: 600; }
.c-late { background: var(--ft-late-bg); color: var(--ft-late-text); }
.c-todo { background: var(--ft-fill); color: var(--ft-text-2); }
.step-chip.fill { border-color: var(--ft-risk); border-style: dashed; }
.legend { margin: 12px 0 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
</style>
