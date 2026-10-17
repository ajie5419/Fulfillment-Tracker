<script setup lang="ts">
/**
 * 齐套（R12）：
 *   选了工单 → 该工单的装配节点卡片（齐套率进度条 + 缺件表，节点顺序）；生产经理、该工单项目经理、管理员可新建 / 编辑 / 删除；
 *   不选工单 → 跨工单视图：按需求日从近到远，可只看未齐套的，展开看缺件。
 * 地址栏 ?wo= 选工单，?incomplete=1 只看未齐套，?id= 定位某个节点（W8 提醒跳过来）。
 */
const route = useRoute()
const router = useRouter()
const { data: workOrders } = await useWorkOrders()

const filter = reactive({
  workOrderNumber: (route.query.wo as string) || undefined,
  // 跨工单视图默认只看未齐套；单个工单默认全看
  incomplete: route.query.incomplete ? route.query.incomplete === '1' : !route.query.wo,
})
watch(
  () => [filter.workOrderNumber, filter.incomplete],
  () => router.replace({ query: { ...route.query, wo: filter.workOrderNumber || undefined, incomplete: filter.incomplete ? '1' : '0' } }),
)

const { data, pending, refresh } = await useFetch('/api/kitting', {
  query: computed(() => ({ workOrderNumber: filter.workOrderNumber, incomplete: filter.incomplete ? '1' : '0' })),
  default: (): KitList => ({ rows: [], total: 0, stats: null, canCreate: false }),
})
const rows = computed(() => data.value.rows as KitNode[])
const stats = computed(() => data.value.stats as KitStats | null)

// ───── ?id= 定位节点（W8 提醒）─────
const focusId = ref<string | null>(null)
async function openFromQuery() {
  const id = route.query.id as string | undefined
  if (!id) return
  try {
    const n = await fetchKitNode(id)
    Object.assign(filter, { workOrderNumber: n.workOrderNumber, incomplete: false })
    focusId.value = n.id
    await nextTick()
    document.getElementById(`node-${n.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  } catch (e) {
    message.error(apiError(e))
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
        await refresh()
      } catch (e) {
        message.error(apiError(e))
      }
    },
  })
}
function showWorkOrder(wo: string, id?: string) {
  Object.assign(filter, { workOrderNumber: wo, incomplete: false })
  focusId.value = id ?? null
}

const crossColumns = [
  { title: '需求日', key: 'needDate', width: 130 },
  { title: '工单', dataIndex: 'workOrderNumber', width: 140 },
  { title: '装配节点', key: 'name' },
  { title: '负责人', key: 'owner', width: 140 },
  { title: '齐套率', key: 'percent', width: 200 },
  { title: '缺件', key: 'short', width: 70, align: 'center' as const },
  { title: '预警', key: 'alert', width: 70 },
]
</script>

<template>
  <a-card title="齐套">
    <template #extra>
      <a-space wrap>
        <a-select
          v-model:value="filter.workOrderNumber"
          allow-clear
          show-search
          placeholder="全部工单（按需求日）"
          style="width: 200px"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: w.workOrderNumber }))"
        />
        <a-checkbox v-model:checked="filter.incomplete">只看未齐套</a-checkbox>
        <a-button @click="refresh()">刷新</a-button>
        <a-button v-if="data.canCreate" type="primary" @click="openEdit(null)">新建装配节点</a-button>
      </a-space>
    </template>

    <div v-if="stats" class="stats">
      <a-space size="large" wrap>
        <span>装配节点 <b>{{ stats.all }}</b></span>
        <a class="stat" @click="filter.incomplete = true">未齐套 <b>{{ stats.incomplete }}</b></a>
        <span :class="{ warn: stats.dueSoon }">其中需求日前 {{ stats.windowDays }} 天内（含已过） <b>{{ stats.dueSoon }}</b></span>
      </a-space>
    </div>
    <p class="muted">
      齐套率 = 已就绪项 ÷ 应有项：工件完成（最后一道工序完成）算就绪，关键物料到货算就绪，已取消的物料不计入。同一工件 / 物料可以挂在多个节点上。
      需求日前 5 天仍未齐套黄色预警，前 1 天或已过红色（阈值在设置里改）；新建、编辑节点限生产经理、该工单项目经理、管理员。
    </p>
    <p v-if="data.total > rows.length" class="warn">共 {{ data.total }} 个节点，只显示前 {{ rows.length }} 个，请按工单筛选</p>

    <!-- 单个工单：节点卡片 -->
    <template v-if="filter.workOrderNumber">
      <a-spin :spinning="pending">
        <a-empty v-if="!rows.length" :description="filter.incomplete ? '该工单没有未齐套的装配节点' : '该工单还没有装配节点'" />
        <a-card
          v-for="n in rows"
          :id="`node-${n.id}`"
          :key="n.id"
          size="small"
          class="node"
          :class="{ focus: focusId === n.id }"
        >
          <template #title>
            <span class="node-name">{{ n.name }}</span>
            <a-tag v-if="n.alertLevel === 'RED'" color="red">红</a-tag>
            <a-tag v-else-if="n.alertLevel === 'YELLOW'" color="orange">黄</a-tag>
            <span class="muted">　需求日 {{ dayText(n.needDate) }}（<span :class="{ warn: n.incomplete && n.daysLeft <= (stats?.windowDays ?? 5) }">{{ daysLeftText(n.daysLeft) }}</span>）　负责人 {{ n.ownerText }}</span>
          </template>
          <template #extra>
            <a-space v-if="n.canEdit" size="small">
              <a-button size="small" @click="openEdit(n)">编辑</a-button>
              <a-button size="small" danger @click="remove(n)">删除</a-button>
            </a-space>
          </template>
          <div class="progress">
            <a-progress v-if="n.percent != null" :percent="n.percent" :status="kitProgressStatus(n)" />
            <span v-else class="muted">清单为空：编辑节点选择需要的工件和关键物料</span>
            <span v-if="n.total" class="muted count">已就绪 {{ n.ready }} / 应有 {{ n.total }}</span>
          </div>
          <KittingShortageTable v-if="n.shortages.length" :shortages="n.shortages" />
          <div v-if="n.readyItems.length" class="muted ready">已就绪：{{ n.readyItems.join('、') }}</div>
          <div v-if="n.excluded.length" class="muted">已取消、不计入：{{ n.excluded.join('、') }}</div>
          <div v-if="n.note" class="muted">备注：{{ n.note }}</div>
        </a-card>
      </a-spin>
    </template>

    <!-- 跨工单：按需求日 -->
    <a-table
      v-else
      :columns="crossColumns"
      :data-source="rows"
      :loading="pending"
      row-key="id"
      size="small"
      :pagination="{ pageSize: 50, hideOnSinglePage: true }"
      :expand-row-by-click="false"
    >
      <template #emptyText><a-empty :description="filter.incomplete ? '没有未齐套的装配节点' : '还没有装配节点'" /></template>
      <template #expandedRowRender="{ record }">
        <KittingShortageTable :shortages="record.shortages" />
        <div v-if="record.readyItems.length" class="muted ready">已就绪：{{ record.readyItems.join('、') }}</div>
      </template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'needDate'">
          {{ dayText(record.needDate) }}
          <div :class="record.incomplete && record.daysLeft <= (stats?.windowDays ?? 5) ? 'warn small' : 'muted'">{{ daysLeftText(record.daysLeft) }}</div>
        </template>
        <template v-else-if="column.key === 'name'">
          <a @click="showWorkOrder(record.workOrderNumber, record.id)">{{ record.name }}</a>
        </template>
        <template v-else-if="column.key === 'owner'"><span :class="{ muted: !record.ownerId }">{{ record.ownerText }}</span></template>
        <template v-else-if="column.key === 'percent'">
          <a-progress v-if="record.percent != null" :percent="record.percent" size="small" :status="kitProgressStatus(record as KitNode)" />
          <span v-else class="muted">清单为空</span>
        </template>
        <template v-else-if="column.key === 'short'">
          <span :class="{ warn: record.shortages.length }">{{ record.shortages.length }}</span>
        </template>
        <template v-else-if="column.key === 'alert'">
          <a-tag v-if="record.alertLevel === 'RED'" color="red">红</a-tag>
          <a-tag v-else-if="record.alertLevel === 'YELLOW'" color="orange">黄</a-tag>
          <span v-else class="muted">—</span>
        </template>
      </template>
    </a-table>
  </a-card>

  <KittingNodeModal :open="editOpen" :node="editing" :work-order-number="filter.workOrderNumber" @close="editOpen = false" @done="saved" />
</template>

<style scoped>
.stats { margin-bottom: 8px; }
.stat { color: inherit; }
.muted { color: #999; font-size: 12px; }
.warn { color: #cf1322; }
.small { font-size: 12px; }
.node { margin-bottom: 12px; }
.node.focus { border-color: #1677ff; box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.2); }
.node-name { font-weight: 600; margin-right: 6px; }
.progress { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.progress :deep(.ant-progress) { flex: 1; max-width: 480px; margin: 0; }
.count { white-space: nowrap; }
.ready { margin-top: 6px; }
</style>
