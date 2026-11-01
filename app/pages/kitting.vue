<script setup lang="ts">
/**
 * 齐套（R12）：
 *   选了工单 → 该工单的装配节点卡片（齐套率进度条 + 缺件表，节点顺序）；生产经理、该工单项目经理、管理员可新建 / 编辑 / 删除；
 *   不选工单 → 跨工单视图：按需求日从近到远，可只看未齐套的，展开看缺件。
 * 地址栏 ?wo= 选工单，?incomplete=1 只看未齐套，?id= 定位某个节点（W8 提醒跳过来）。
 * 节点负责人本人看不到该工单时（不在可见范围），工单列表接口不给它，?id= 拿到的节点在顶部单独显示。
 * 前端改版第二轮：顶部统计卡（装配节点 / 未齐套 / 需求日临近未齐套 / 平均齐套率），前三张点了套用筛选（?incomplete=1、?dueSoon=1，
 * 数字是接口 stats，与筛选同一口径）；平均齐套率按当前列表里清单不为空的节点算。节点卡片用环形进度 + 缺件按原因计数。
 */
import { averagePercent, shortageReasonCounts } from '#shared/workbench'

const route = useRoute()
const router = useRouter()
const { data: workOrders, pending: ordersPending, error: ordersError, refresh: refreshOrders } = await useWorkOrders()

const filter = reactive({
  workOrderNumber: (route.query.wo as string) || undefined,
  // 跨工单视图默认只看未齐套；单个工单默认全看
  incomplete: route.query.incomplete ? route.query.incomplete === '1' : !route.query.wo,
  /** 只看需求日临近（W8 预警窗口内，含已过）仍未齐套的 */
  dueSoon: route.query.dueSoon === '1',
})
watch(
  () => [filter.workOrderNumber, filter.incomplete, filter.dueSoon],
  () => router.replace({ query: { ...route.query, wo: filter.workOrderNumber || undefined, incomplete: filter.incomplete ? '1' : '0', dueSoon: filter.dueSoon ? '1' : undefined } }),
)

const { data, pending, error, refresh } = await useFetch('/api/kitting', {
  query: computed(() => ({ workOrderNumber: filter.workOrderNumber, incomplete: filter.incomplete ? '1' : '0', dueSoon: filter.dueSoon ? '1' : undefined })),
  default: (): KitList => ({ rows: [], total: 0, stats: null, canCreate: false }),
})
const { state, displayStat } = useRequestState({ pending, error }, () => !data.value.rows.length)
const rows = computed(() => data.value.rows as KitNode[])
const stats = computed(() => data.value.stats as KitStats | null)
const avgPercent = computed(() => averagePercent(rows.value))
/** 点统计卡：all = 全部节点，incomplete = 未齐套，dueSoon = 需求日临近未齐套 */
// 取消"只看未齐套"时一并取消"需求日临近"
watch(
  () => filter.incomplete,
  (v) => {
    if (!v) filter.dueSoon = false
  },
)
function applyCard(kind: 'all' | 'incomplete' | 'dueSoon') {
  filter.incomplete = kind !== 'all'
  filter.dueSoon = kind === 'dueSoon'
}

// ───── ?id= 定位节点（W8 提醒）─────
const focusId = ref<string | null>(null)
/** 从提醒打开、但该工单不在我的可见范围（我是节点负责人）：单独显示 */
const standalone = ref<KitNode | null>(null)
const nodeError = ref('')
const nodePending = ref(false)
async function openFromQuery() {
  const id = route.query.id as string | undefined
  if (!id) return
  nodeError.value = ''
  nodePending.value = true
  try {
    const n = await fetchKitNode(id)
    focusId.value = n.id
    if (workOrders.value.some((w) => w.workOrderNumber === n.workOrderNumber)) {
      standalone.value = null
      Object.assign(filter, { workOrderNumber: n.workOrderNumber, incomplete: false, dueSoon: false })
    } else {
      standalone.value = n
    }
    await nextTick()
    document.getElementById(`node-${n.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  } catch (e) {
    nodeError.value = apiError(e)
  } finally {
    nodePending.value = false
  }
}
onMounted(openFromQuery)
watch(() => route.query.id, openFromQuery)
watch(rows, async () => {
  if (!focusId.value) return
  await nextTick()
  document.getElementById(`node-${focusId.value}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
})

// ───── 新建 / 编辑 / 删除 ─────
const editing = ref<KitNode | null>(null)
const editOpen = ref(false)
function openEdit(n: KitNode | null) {
  editing.value = n
  editOpen.value = true
}
async function saved() {
  editOpen.value = false
  await refresh()
  if (standalone.value) await openFromQuery()
}
function remove(n: KitNode) {
  Modal.confirm({
    title: `删除装配节点：${n.name}？`,
    content: '只删除节点和它的清单，工件和关键物料本身不受影响；该节点的 W8 预警一并消除',
    okText: '删除',
    okType: 'danger',
    async onOk() {
      try {
        await kittingSend(`/api/kitting/${n.id}`, 'DELETE')
        message.success('已删除')
        if (standalone.value?.id === n.id) standalone.value = null
        await refresh()
      } catch (e) {
        message.error(apiError(e))
      }
    },
  })
}
function showWorkOrder(wo: string, id?: string) {
  Object.assign(filter, { workOrderNumber: wo, incomplete: false, dueSoon: false })
  focusId.value = id ?? null
}

/** 列宽按内容收紧（设计规范）：合计约 1100px，1440 宽屏幕不用横向滚动 */
const crossColumns = [
  { title: '需求日', key: 'needDate', width: 110 },
  { title: '工单', key: 'wo', width: 130 },
  { title: '装配节点', key: 'name' },
  { title: '总计划节点', key: 'planNode', width: 110 },
  { title: '负责人', key: 'owner', width: 100 },
  { title: '齐套率', key: 'percent', width: 180 },
  { title: '缺件', key: 'short', width: 190 },
  { title: '预警', key: 'alert', width: 64 },
]
</script>

<template>
  <div>
  <div class="ft-page">
  <div class="ft-stats">
    <UiStatCard label="装配节点" :value="displayStat(stats?.all)" unit="个" tone="primary" accent icon="dot" clickable :active="!filter.incomplete" :sub="filter.workOrderNumber ? `工单 ${filter.workOrderNumber}` : '全部工单'" @click="applyCard('all')" />
    <UiStatCard label="未齐套" :value="displayStat(stats?.incomplete)" unit="个" tone="risk" accent icon="warn" clickable :active="filter.incomplete && !filter.dueSoon" @click="applyCard('incomplete')" />
    <UiStatCard label="需求日临近未齐套" :value="displayStat(stats?.dueSoon)" unit="个" tone="late" accent icon="alert" clickable :active="filter.dueSoon" :sub="stats ? `需求日前 ${stats.windowDays} 天内（含已过）` : '需求日临近（含已过）'" @click="applyCard('dueSoon')" />
    <UiStatCard label="平均齐套率" tone="done" accent icon="check" :sub="pending || error ? '当前列表未加载' : `按当前列表 ${rows.filter((r) => r.percent != null).length} 个节点（清单为空的不算）`">
      <template #value>
        <span class="avg">
          <UiRing v-if="!pending && !error && avgPercent != null" :value="avgPercent" :total="100" :size="44" :stroke="6" color="var(--ft-done)" label="" />
          <b>{{ pending || error || avgPercent == null ? '—' : `${avgPercent}%` }}</b>
        </span>
      </template>
    </UiStatCard>
  </div>
  <a-alert v-if="ordersError" type="error" message="工单选项加载失败" :description="apiError(ordersError)"><template #action><a-button @click="refreshOrders()">重试</a-button></template></a-alert>
  <a-card>
    <template #title>
      <span class="ft-title">齐套
        <UiHelpTip label="齐套说明">齐套率 = 已就绪项 ÷ 应有项：工件完成（最后一道工序完成）算就绪，关键物料到货算就绪，已取消的物料不计入。同一工件 / 物料可以挂在多个节点上。
      <template v-if="stats">需求日前 {{ stats.yellowDays }} 天内仍未齐套黄色预警，{{ stats.redDays ? `前 ${stats.redDays} 天内（含当天）` : '当天' }}或已过红色（阈值在设置里改）；</template>新建、编辑节点限生产经理、该工单项目经理、管理员。</UiHelpTip>
      </span>
    </template>
    <template #extra>
      <a-space wrap>
        <a-select
          v-model:value="filter.workOrderNumber"
          :loading="ordersPending" :disabled="!!ordersError"
          allow-clear
          show-search
          placeholder="全部工单（按需求日）"
          style="width: 200px"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: w.workOrderNumber }))"
        />
        <a-checkbox v-model:checked="filter.incomplete">只看未齐套</a-checkbox>
        <a-tag v-if="filter.dueSoon" color="red" closable @close="filter.dueSoon = false">需求日临近</a-tag>
        <UiRefreshButton @click="refresh()" />
        <a-button v-if="data.canCreate" type="primary" @click="openEdit(null)">新建装配节点</a-button>
      </a-space>
    </template>

    <a-spin v-if="nodePending" />
    <a-alert v-else-if="nodeError" type="error" message="提醒节点加载失败" :description="nodeError"><template #action><a-button @click="openFromQuery()">重试</a-button></template></a-alert>
    <template v-else-if="standalone">
      <div class="section muted">提醒的节点（你是负责人；该工单不在你的可见范围，只能看这个节点）<button type="button" class="link-btn" @click="standalone = null">收起</button></div>
      <KittingNodeCard :node="standalone" focus :linkable="false" :window-days="stats?.windowDays ?? 5" @edit="openEdit" @remove="remove" />
    </template>
    <p v-if="state === 'success' && data.total > rows.length" class="warn">共 {{ data.total }} 个节点，只显示前 {{ rows.length }} 个，请按工单筛选</p>

    <a-spin v-if="state === 'loading'" />
    <a-result v-else-if="state === 'error'" status="error" title="齐套数据加载失败" :sub-title="apiError(error)"><template #extra><a-button @click="refresh()">重试</a-button></template></a-result>
    <template v-else>
    <!-- 单个工单：节点卡片 -->
    <template v-if="filter.workOrderNumber">
      <a-spin :spinning="pending">
        <a-empty v-if="!rows.length" :description="filter.incomplete ? '该工单没有未齐套的装配节点' : '该工单还没有装配节点'" />
        <KittingNodeCard
          v-for="n in rows"
          :key="n.id"
          :node="n"
          :focus="focusId === n.id"
          :window-days="stats?.windowDays ?? 5"
          @edit="openEdit"
          @remove="remove"
        />
      </a-spin>
    </template>

    <!-- 跨工单：按需求日 -->
    <a-table
      v-else
      class="ft-table"
      :columns="crossColumns"
      :data-source="rows"
      :loading="pending"
      row-key="id"
      size="small"
      :pagination="{ pageSize: 50, hideOnSinglePage: true }"
      :expand-row-by-click="false"
      :scroll="{ x: 1100 }"
    >
      <template #emptyText><a-empty :description="filter.incomplete ? '没有未齐套的装配节点' : '还没有装配节点'" /></template>
      <template #expandedRowRender="{ record }">
        <KittingShortageTable :shortages="record.shortages" :empty-text="record.total ? '不缺件' : '清单为空：编辑节点选择需要的工件和关键物料'" />
        <div v-if="record.readyItems.length" class="muted ready">已就绪：{{ record.readyItems.join('、') }}</div>
      </template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'needDate'">
          {{ dayText(record.needDate) }}
          <div :class="record.incomplete && record.daysLeft <= (stats?.windowDays ?? 5) ? 'warn small' : 'muted'">{{ daysLeftText(record.daysLeft) }}</div>
        </template>
        <template v-else-if="column.key === 'name'">
          <button type="button" class="link-btn" @click="showWorkOrder(record.workOrderNumber, record.id)">{{ record.name }}</button>
        </template>
        <template v-else-if="column.key === 'wo'"><WoLink :no="record.workOrderNumber" /></template>
        <template v-else-if="column.key === 'planNode'"><PlanNodeCell :work-order-number="record.workOrderNumber" :node="record.planNode" /></template>
        <template v-else-if="column.key === 'owner'"><span :class="{ muted: !record.ownerId }">{{ record.ownerText }}</span></template>
        <template v-else-if="column.key === 'percent'">
          <a-progress v-if="record.percent != null" :percent="record.percent" size="small" :status="kitProgressStatus(record as KitNode)" />
          <span v-else class="muted">清单为空</span>
        </template>
        <template v-else-if="column.key === 'short'">
          <span :class="{ warn: record.shortages.length }">{{ record.shortages.length }}</span>
          <div v-if="record.shortages.length" class="reasons">
            <a-tag v-for="r in shortageReasonCounts(record.shortages)" :key="r.reason" :color="BLOCKER_COLOR[r.code] ?? 'default'" class="reason">{{ r.reason }} {{ r.count }}</a-tag>
          </div>
        </template>
        <template v-else-if="column.key === 'alert'">
          <a-tag v-if="record.alertLevel === 'RED'" color="red">红</a-tag>
          <a-tag v-else-if="record.alertLevel === 'YELLOW'" color="orange">黄</a-tag>
          <span v-else class="muted">—</span>
        </template>
      </template>
    </a-table>
    </template>
  </a-card>
  </div>

  <KittingNodeModal :open="editOpen" :node="editing" :work-order-number="filter.workOrderNumber" @close="editOpen = false" @done="saved" />
  </div>
</template>

<style scoped>
.avg { display: inline-flex; align-items: center; gap: 10px; }
.avg :deep(.txt) { font-size: 12px; }
.reasons { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.reason { margin: 0; font-size: 11px; line-height: 18px; }
.muted { color: var(--ft-text-2); font-size: 12px; }
.link-btn { padding: 0; border: 0; background: none; font: inherit; color: var(--ft-primary); text-align: left; cursor: pointer; }
.link-btn:hover { text-decoration: underline; }
.link-btn:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; border-radius: 2px; }
.warn { color: var(--ft-late-text); }
.small { font-size: 12px; }
.ready { margin-top: 6px; }
.section { display: flex; justify-content: space-between; margin-bottom: 6px; }
</style>
