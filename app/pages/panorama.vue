<script setup lang="ts">
import type { PanoramaData } from '#shared/panorama'

const { data, pending, error, refresh } = await useFetch<PanoramaData>('/api/panorama', { key: 'panorama' })

const counts = computed(() => data.value?.counts)

function displayStat(value: number | null | undefined): number | string {
  if (pending.value || error.value || value == null) return '—'
  return value
}

const heroSummary = computed(() => {
  if (error.value || !counts.value) return '项目盘子规模与交付健康态势'
  return `在制工单 ${counts.value.inProgress} 个，其中正常 ${counts.value.normal} 个、异常 ${counts.value.abnormal} 个`
})

const managerColumns = [
  { title: '项目经理', dataIndex: 'name', key: 'name' },
  { title: '在制数', dataIndex: 'inProgress', key: 'inProgress', align: 'right' as const, width: 90 },
  { title: '异常数', dataIndex: 'abnormal', key: 'abnormal', align: 'right' as const, width: 110 },
]

const managerRows = computed(() =>
  (data.value?.byManager ?? []).map((m, idx) => ({
    key: m.projectManagerId ?? `manager:${m.projectManagerName}:${idx}`,
    name: m.projectManagerName,
    inProgress: m.inProgress,
    abnormal: m.abnormal,
  })),
)

const productLineColumns = [
  { title: '产品线', dataIndex: 'name', key: 'name' },
  { title: '在制数', dataIndex: 'inProgress', key: 'inProgress', align: 'right' as const, width: 90 },
  { title: '异常数', dataIndex: 'abnormal', key: 'abnormal', align: 'right' as const, width: 110 },
]

const productLineRows = computed(() =>
  (data.value?.byProductLine ?? []).map((p, idx) => ({
    key: p.productLine ?? `pl:${idx}`,
    name: p.productLine || '未指定产品线',
    inProgress: p.inProgress,
    abnormal: p.abnormal,
  })),
)
</script>

<template>
  <div class="panorama">
    <UiPageHero title="项目全景" :summary="heroSummary">
      <template #titleAfter>
        <UiHelpTip label="项目全景说明">宏观掌握项目全盘规模与健康度。在制工单分为正常与异常；未开工统计对应状态为 OPEN 的工单；现场验收待数据接入后显示。</UiHelpTip>
      </template>
      <template #actions>
        <UiRefreshButton :loading="pending" @click="refresh()" />
      </template>
    </UiPageHero>

    <a-result v-if="error" status="error" title="项目全景加载失败" :sub-title="apiError(error)">
      <template #extra>
        <a-button type="primary" @click="refresh()">重试</a-button>
      </template>
    </a-result>

    <template v-else>
      <a-spin :spinning="pending">
        <div class="panorama-body">
          <div class="panorama-counts">
            <UiStatCard
              label="在制"
              :value="displayStat(counts?.inProgress)"
              unit="个"
              tone="primary"
            />
            <UiStatCard
              label="正常"
              :value="displayStat(counts?.normal)"
              unit="个"
              tone="done"
            />
            <UiStatCard
              label="异常"
              :value="displayStat(counts?.abnormal)"
              unit="个"
              tone="late"
            />
            <UiStatCard
              label="完成"
              :value="displayStat(counts?.completed)"
              unit="个"
              tone="done"
            />
            <UiStatCard
              label="未开工"
              :value="displayStat(counts?.notStarted)"
              unit="个"
              tone="none"
              sub="未开工（状态 OPEN）"
            />
            <UiStatCard
              label="未验收"
              value="待接入"
              tone="none"
              sub="现场验收数据接入后显示"
            />
          </div>

          <div class="panorama-distributions">
            <UiSectionCard title="按项目经理" icon="bars" padding="none">
              <a-table
                class="ft-table"
                :columns="managerColumns"
                :data-source="managerRows"
                :pagination="false"
                row-key="key"
                size="small"
              >
                <template #bodyCell="{ column, record }">
                  <template v-if="column.key === 'abnormal'">
                    <UiStatusTag v-if="record.abnormal > 0" tone="late">异常 {{ record.abnormal }}</UiStatusTag>
                    <span v-else class="ft-muted">0</span>
                  </template>
                </template>
              </a-table>
            </UiSectionCard>

            <UiSectionCard title="按产品线" icon="chart" padding="none">
              <a-table
                class="ft-table"
                :columns="productLineColumns"
                :data-source="productLineRows"
                :pagination="false"
                row-key="key"
                size="small"
              >
                <template #bodyCell="{ column, record }">
                  <template v-if="column.key === 'abnormal'">
                    <UiStatusTag v-if="record.abnormal > 0" tone="late">异常 {{ record.abnormal }}</UiStatusTag>
                    <span v-else class="ft-muted">0</span>
                  </template>
                </template>
              </a-table>
            </UiSectionCard>
          </div>
        </div>
      </a-spin>
    </template>
  </div>
</template>

<style scoped>
.panorama {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 24px;
}
.panorama-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.panorama-counts {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 16px;
}
.panorama-distributions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
@media (max-width: 1199px) {
  .panorama-counts {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 991px) {
  .panorama-distributions {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 575px) {
  .panorama {
    gap: 12px;
  }
  .panorama-body {
    gap: 12px;
  }
  .panorama-counts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .panorama-distributions {
    gap: 12px;
  }
  .panorama-distributions :deep(.ft-table .ant-table-cell) {
    padding: 8px 6px;
    font-size: 13px;
  }
}
</style>
