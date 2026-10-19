<script setup lang="ts">
/** 预警列表：活动中的预警，按规则、级别、工单筛选。预警由扫描任务每 15 分钟更新，对象状态变化后自动消除 */
const route = useRoute()
const { data: workOrders } = await useWorkOrders()
const filter = reactive({
  rule: (route.query.rule as string) || undefined,
  level: (route.query.level as string) || undefined,
  workOrderNumber: (route.query.wo as string) || undefined,
})
const { data: rows, pending, refresh } = await useFetch('/api/alerts', {
  query: computed(() => ({ ...filter })),
  default: () => [],
})

const ownerText = (owners: { name: string }[]) => owners.map((o) => o.name).join('、')
const ruleOptions = (['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9'] as const).map((r) => ({ value: r, label: RULE_TEXT[r] }))
const levelOptions = LEVEL_ORDER.map((l) => ({ value: l, label: LEVEL_TEXT[l] }))
const columns = [
  { title: '级别', key: 'level', width: 80 },
  { title: '规则', key: 'rule', width: 150 },
  { title: '对象', key: 'subject' },
  { title: '工单', key: 'wo', width: 140 },
  { title: '情况 / 已持续', key: 'summary' },
  { title: '责任人', key: 'owners', width: 140 },
  { title: '首次预警 / 升级', key: 'time', width: 180 },
  { title: '', key: 'convert', width: 150 },
]

/** 黄色预警手动转异常（责任人、项目经理、管理员）；红色由扫描任务自动转 */
const converting = ref<string | null>(null)
const convertRow = (r: Record<string, unknown>) => convert({ id: String(r.id), subject: String(r.subject) })
function convert(row: { id: string; subject: string }) {
  Modal.confirm({
    title: `把这条预警转为异常？`,
    content: row.subject,
    okText: '转异常',
    async onOk() {
      converting.value = row.id
      try {
        const r = await ($fetch as unknown as (u: string, o: { method: 'POST' }) => Promise<{ issueId: string; issueNo: string }>)(`/api/alerts/${row.id}/convert`, { method: 'POST' })
        message.success(`已转为异常 ${r.issueNo}`)
        await refresh()
      } catch (e) {
        message.error(apiError(e))
      } finally {
        converting.value = null
      }
    },
  })
}
</script>

<template>
  <a-card title="预警列表">
    <template #extra>
      <a-space>
        <a-select v-model:value="filter.rule" allow-clear placeholder="全部规则" style="width: 170px" :options="ruleOptions" />
        <a-select v-model:value="filter.level" allow-clear placeholder="全部级别" style="width: 110px" :options="levelOptions" />
        <a-select
          v-model:value="filter.workOrderNumber"
          allow-clear
          show-search
          placeholder="全部工单"
          style="width: 200px"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: w.workOrderNumber }))"
        />
        <a-button @click="refresh()">刷新</a-button>
      </a-space>
    </template>
    <a-table :columns="columns" :data-source="rows" :loading="pending" row-key="id" size="small" :pagination="{ pageSize: 50, hideOnSinglePage: true }">
      <template #emptyText><a-empty description="没有活动中的预警" /></template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'level'">
          <a-tag :color="LEVEL_COLOR[record.level as AlertLevelKey]">{{ LEVEL_TEXT[record.level as AlertLevelKey] }}</a-tag>
        </template>
        <template v-else-if="column.key === 'rule'">{{ RULE_TEXT[record.rule as keyof typeof RULE_TEXT] }}</template>
        <template v-else-if="column.key === 'subject'">
          <NuxtLink v-if="record.link" :to="record.link">{{ record.subject }}</NuxtLink>
          <span v-else>{{ record.subject }}</span>
        </template>
        <template v-else-if="column.key === 'wo'"><WoLink :no="record.workOrderNumber" /></template>
        <template v-else-if="column.key === 'summary'">
          {{ record.summary }}
          <div v-if="record.duration" class="muted">已持续 {{ record.duration }}（不含停工日）</div>
        </template>
        <template v-else-if="column.key === 'owners'">
          <span v-if="!record.owners.length" class="muted">未设置</span>
          <span v-else>{{ ownerText(record.owners) }}</span>
        </template>
        <template v-else-if="column.key === 'time'">
          <div>{{ timeText(record.firstAt) }}</div>
          <div class="muted">{{ timeText(record.levelAt) }}</div>
        </template>
        <template v-else-if="column.key === 'convert'">
          <NuxtLink v-if="record.issue" :to="`/issues?id=${encodeURIComponent(record.issue.id)}`"><a-tag color="purple">已转异常 {{ record.issue.issueNo }}</a-tag></NuxtLink>
          <a-button v-else-if="record.canConvert" size="small" danger :loading="converting === record.id" @click="convertRow(record)">转异常</a-button>
        </template>
      </template>
    </a-table>
  </a-card>
</template>

<style scoped>
.muted { color: #999; font-size: 12px; }
</style>
