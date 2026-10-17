<script setup lang="ts">
/**
 * 发放签收（R9）：图纸、设计变更、工艺文件的发放单列表；按工单、类型、签收进度、我发出的/发给我的筛选。
 * 点一行打开详情抽屉（签收情况、签收/拒收、确认变更影响、作废）。地址栏 ?id= 直接打开某张，?wo= 预选工单。
 */
const route = useRoute()
const router = useRouter()
const { data: workOrders } = await useWorkOrders()

const filter = reactive({
  workOrderNumber: (route.query.wo as string) || undefined,
  type: (route.query.type as string) || undefined,
  progress: (route.query.progress as string) || undefined,
  mine: (route.query.mine as string) || '',
})
const { data: rows, pending, refresh } = await useFetch('/api/releases', {
  query: computed(() => ({ ...filter, mine: filter.mine || undefined })),
  default: () => [],
})

const selected = ref<string | null>((route.query.id as string) || null)
// 页面没换、只换了 ?id=（从提醒或别的链接跳过来）时也要跟着打开
watch(
  () => route.query.id,
  (id) => {
    const v = (id as string) || null
    if (v !== selected.value) selected.value = v
  },
)
watch(selected, (id) => {
  if (import.meta.client) router.replace({ query: { ...route.query, id: id || undefined } })
})
const rowProps = (r: Record<string, unknown>) => ({ onClick: () => (selected.value = String(r.id)), style: 'cursor: pointer' })

const creating = ref(false)
async function created(id: string) {
  creating.value = false
  await refresh()
  selected.value = id
}

const typeOptions = Object.entries(RELEASE_TYPE_TEXT).map(([value, label]) => ({ value, label }))
const progressOptions = [
  { value: 'PENDING', label: '有人未签收' },
  { value: 'REJECTED', label: '有拒收' },
  { value: 'VOID', label: '已作废' },
]
const columns = [
  { title: '编号', key: 'releaseNo', width: 150 },
  { title: '类型', key: 'type', width: 100 },
  { title: '工单', dataIndex: 'workOrderNumber', width: 140 },
  { title: '工件 / 版本', key: 'parts', width: 200 },
  { title: '说明', key: 'description' },
  { title: '发放人', dataIndex: 'issuerName', width: 100 },
  { title: '签收', key: 'progress', width: 150 },
  { title: '发放时间', key: 'createdAt', width: 165 },
]
</script>

<template>
  <a-card title="发放签收">
    <template #extra>
      <a-space wrap>
        <a-radio-group v-model:value="filter.mine" button-style="solid" size="small">
          <a-radio-button value="">全部</a-radio-button>
          <a-radio-button value="received">发给我的</a-radio-button>
          <a-radio-button value="issued">我发出的</a-radio-button>
        </a-radio-group>
        <a-select v-model:value="filter.type" allow-clear placeholder="全部类型" style="width: 120px" :options="typeOptions" />
        <a-select v-model:value="filter.progress" allow-clear placeholder="全部进度" style="width: 130px" :options="progressOptions" />
        <a-select
          v-model:value="filter.workOrderNumber"
          allow-clear
          show-search
          placeholder="全部工单"
          style="width: 180px"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: w.workOrderNumber }))"
        />
        <a-button @click="refresh()">刷新</a-button>
        <a-button type="primary" @click="creating = true">新建发放</a-button>
      </a-space>
    </template>
    <p class="muted">纸质图纸照旧下发，这里登记发给谁，接收人在手机或电脑上签收；超时没签收按 W5 预警。设计变更会提醒确认在加工工序的影响，未开工工序标"等变更"。</p>
    <a-table :columns="columns" :data-source="rows" :loading="pending" row-key="id" size="small" :custom-row="rowProps" :pagination="{ pageSize: 50, hideOnSinglePage: true }">
      <template #emptyText><a-empty description="还没有发放单" /></template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'releaseNo'">
          {{ record.releaseNo }}
          <a-tag v-if="record.myStatus === 'PENDING'" color="orange">待我签收</a-tag>
        </template>
        <template v-else-if="column.key === 'type'">
          <a-tag :color="RELEASE_TYPE_COLOR[record.type as ReleaseTypeKey]">{{ record.typeText }}</a-tag>
          <a-tag v-if="record.heldSteps" color="purple">等变更 {{ record.heldSteps }}</a-tag>
        </template>
        <template v-else-if="column.key === 'parts'">
          {{ record.parts.join('、') || '—' }}
          <div v-if="record.version" class="muted">版本 {{ record.version }}</div>
        </template>
        <template v-else-if="column.key === 'description'"><span class="desc">{{ record.description }}</span></template>
        <template v-else-if="column.key === 'progress'">
          <a-tag :color="PROGRESS_COLOR[record.progressText]">{{ record.progressText }}</a-tag>
          <span class="muted">{{ record.counts.SIGNED }}/{{ record.total }}</span>
        </template>
        <template v-else-if="column.key === 'createdAt'">{{ timeText(record.createdAt) }}</template>
      </template>
    </a-table>
  </a-card>

  <ReleaseCreateModal :open="creating" :work-order-number="filter.workOrderNumber" @close="creating = false" @done="created" />
  <ReleaseDrawer :id="selected" @close="selected = null" @changed="refresh()" />
</template>

<style scoped>
.muted { color: #999; font-size: 12px; }
.desc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
</style>
