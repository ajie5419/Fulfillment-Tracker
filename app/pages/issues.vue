<script setup lang="ts">
/**
 * 异常列表（技术选型 6.2）：按状态、分类、工单筛选；本部门/全部（部门负责人默认本部门）；我负责/我上报/等我处理。
 * 点一行打开详情抽屉，在抽屉里受理、改派、填处理结果、确认关闭、退回。地址栏 ?id= 直接打开某条。
 */
const route = useRoute()
const router = useRouter()
const { data: me } = await useMe()
const { data: workOrders } = await useWorkOrders()

const filter = reactive({
  status: ((route.query.status as string) || 'UNCLOSED') as string | undefined,
  category: (route.query.category as string) || undefined,
  workOrderNumber: (route.query.wo as string) || undefined,
  // 部门负责人默认看本部门，可切换全部
  dept: (route.query.dept as string) ?? (me.value?.deptHeadOf.length ? '1' : '0'),
  mine: (route.query.mine as string) || undefined,
})
const { data: rows, pending, refresh } = await useFetch('/api/issues', {
  query: computed(() => ({ ...filter, status: filter.status || undefined })),
  default: () => [],
})

const selected = ref<string | null>((route.query.id as string) || null)
watch(selected, (id) => {
  if (import.meta.client) router.replace({ query: { ...route.query, id: id || undefined } })
})

/** 点一行打开详情 */
const rowProps = (r: Record<string, unknown>) => ({ onClick: () => (selected.value = String(r.id)), style: 'cursor: pointer' })

const statusOptions = [
  { value: 'UNCLOSED', label: '未关闭' },
  ...Object.entries(ISSUE_STATUS_TEXT).map(([value, label]) => ({ value, label })),
]
const categoryOptions = Object.entries(ISSUE_CATEGORY_TEXT).map(([value, label]) => ({ value, label }))
const mineOptions = [
  { value: 'todo', label: '等我处理' },
  { value: 'responsible', label: '我负责的' },
  { value: 'reported', label: '我上报的' },
]
const columns = [
  { title: '编号', key: 'issueNo', width: 140 },
  { title: '工单', dataIndex: 'workOrderNumber', width: 130 },
  { title: '分类', key: 'category', width: 110 },
  { title: '描述', key: 'description' },
  { title: '来源', key: 'source', width: 100 },
  { title: '责任部门 / 人 / 外协单位', key: 'responsible', width: 190 },
  { title: '要求解决日', key: 'dueDate', width: 110 },
  { title: '状态', key: 'status', width: 90 },
  { title: '超期', key: 'overdue', width: 90 },
]
</script>

<template>
  <a-card title="异常列表">
    <template #extra>
      <a-space wrap>
        <a-radio-group v-model:value="filter.dept" button-style="solid" size="small">
          <a-radio-button value="1">本部门</a-radio-button>
          <a-radio-button value="0">全部</a-radio-button>
        </a-radio-group>
        <a-select v-model:value="filter.mine" allow-clear placeholder="全部人" style="width: 110px" :options="mineOptions" />
        <a-select v-model:value="filter.status" allow-clear placeholder="全部状态" style="width: 100px" :options="statusOptions" />
        <a-select v-model:value="filter.category" allow-clear placeholder="全部分类" style="width: 130px" :options="categoryOptions" />
        <a-select
          v-model:value="filter.workOrderNumber"
          allow-clear
          show-search
          placeholder="全部工单"
          style="width: 180px"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: w.workOrderNumber }))"
        />
        <a-button @click="refresh()">刷新</a-button>
      </a-space>
    </template>
    <p class="muted">手机上报：打开手机端"异常"→"上报异常"。系统会把 QMS 检验不合格和红色预警自动转成异常。</p>
    <a-table
      :columns="columns"
      :data-source="rows"
      :loading="pending"
      row-key="id"
      size="small"
      :pagination="{ pageSize: 50, hideOnSinglePage: true }"
      :custom-row="rowProps"
    >
      <template #emptyText><a-empty description="没有符合条件的异常" /></template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'issueNo'"><a>{{ record.issueNo }}</a></template>
        <template v-else-if="column.key === 'category'">{{ record.categoryText }}</template>
        <template v-else-if="column.key === 'description'">
          <div class="ellipsis">{{ record.description }}</div>
          <div v-if="record.refText" class="muted">{{ record.refText }}<template v-if="record.photoCount">　照片 {{ record.photoCount }} 张</template></div>
        </template>
        <template v-else-if="column.key === 'source'">{{ ISSUE_SOURCE_TEXT[record.source as keyof typeof ISSUE_SOURCE_TEXT] }}</template>
        <template v-else-if="column.key === 'responsible'">
          <div>{{ record.responsibleDeptName ?? '—' }} / {{ record.responsibleUserName ?? '未指定' }}</div>
          <div v-if="record.responsibleSupplierName" class="muted">{{ record.responsibleSupplierName }}</div>
        </template>
        <template v-else-if="column.key === 'dueDate'">{{ dayText(record.dueDate) || '—' }}</template>
        <template v-else-if="column.key === 'status'">
          <a-tag :color="ISSUE_STATUS_COLOR[record.status as IssueStatusKey]">{{ ISSUE_STATUS_TEXT[record.status as IssueStatusKey] }}</a-tag>
        </template>
        <template v-else-if="column.key === 'overdue'">
          <a-tag v-if="record.overdue" :color="record.alertLevel === 'RED' ? 'red' : 'orange'">{{ record.overdueDays ? `超期 ${record.overdueDays} 天` : '待受理超时' }}</a-tag>
        </template>
      </template>
    </a-table>
  </a-card>

  <IssueDrawer :id="selected" @close="selected = null" @changed="refresh()" />
</template>

<style scoped>
.muted { color: #999; font-size: 12px; }
.ellipsis { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
