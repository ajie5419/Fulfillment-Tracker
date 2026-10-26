<script setup lang="ts">
/**
 * 车间看板（10-26 借鉴 ERPNext 作业卡看板，只读）：工序按状态分五列——可以开工 / 加工中 / 在外加工 / 有异常 / 近 7 天完成。
 * 可按工单、班组 / 外协厂筛选（地址栏 ?wo= &supplierId=，全局搜索搜外协厂、班组时跳到这里）。
 * 开工、完工、发出等操作仍在"生产管理"和手机端做；卡片点开跳到对应工件。
 */
const route = useRoute()
const router = useRouter()
const { data: workOrders } = await useWorkOrders()
const { data: master } = await useMaster()

const wo = ref((route.query.wo as string) || '')
const supplierId = ref((route.query.supplierId as string) || '')
watch([wo, supplierId], ([w, s]) => router.replace({ query: { ...(w ? { wo: w } : {}), ...(s ? { supplierId: s } : {}) } }))
// 页面没离开时点了别的 /workshop 链接（全局搜索搜班组 / 外协厂），按新地址切筛选
watch(() => [route.query.wo, route.query.supplierId], ([w, s]) => {
  wo.value = (w as string) || ''
  supplierId.value = (s as string) || ''
})

const { data: columns, pending, refresh } = await useFetch('/api/workshop', {
  query: computed(() => ({ wo: wo.value || undefined, supplierId: supplierId.value || undefined })),
  default: () => [],
})

const COLUMN_TEXT = { ready: '可以开工', working: '加工中', out: '在外加工', blocked: '有异常', done: '近 7 天完成' } as const
const COLUMN_TONE = { ready: 'none', working: 'primary', out: 'primary', blocked: 'late', done: 'done' } as const
const COLUMN_HELP = {
  ready: '待开工、且上一道已完成或已有部分返回（第一道直接算）',
  working: '自制、厂内外协已开工还没完工',
  out: '厂外外协已发出、还没全部返回',
  blocked: 'QMS 判不合格，等异常处理',
  done: '最近 7 天完成的工序',
} as const

const woOptions = computed(() => [{ value: '', label: '全部工单' }, ...workOrders.value.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? w.customerName}` }))])
// 班组在前（派工看班组），外协厂在后
const supplierOptions = computed(() => [
  { value: '', label: '全部班组 / 外协厂' },
  ...master.value.suppliers.filter((s) => s.kind === 'TEAM').map((s) => ({ value: s.id, label: `${s.name}（班组）` })),
  ...master.value.suppliers.filter((s) => s.kind !== 'TEAM').map((s) => ({ value: s.id, label: s.name })),
])
type Card = (typeof columns.value)[number]['cards'][number]
const total = computed(() => columns.value.reduce((n, c) => n + c.cards.length, 0))
const modeText = (c: Card) => (c.mode === 'SELF' ? `自制${c.supplierName ? ` · ${c.supplierName}` : ''}` : c.supplierName ?? MODE_TEXT[c.mode])
function dateLine(c: Card) {
  if (c.column === 'done') return `完成 ${timeText(c.finishedAt)}`
  if (c.column === 'out') return c.promisedReturnDate ? `承诺返回 ${dayText(c.promisedReturnDate)}` : '未填承诺返回日'
  if (c.column === 'ready') return c.planStartDate ? `应开工 ${dayText(c.planStartDate)}` : c.dueDate ? `要求完成 ${dayText(c.dueDate)}` : '未定日期'
  return c.dueDate ? `要求完成 ${dayText(c.dueDate)}` : '未定要求完成日'
}
const partLink = (c: Card) => `/parts?wo=${encodeURIComponent(c.workOrderNumber)}&part=${encodeURIComponent(c.partId)}`
</script>

<template>
  <a-card>
    <template #title>
      <span class="ft-title">车间看板 <UiHelpTip>工序按状态分列，只看不改；开工、完工、发出请到"生产管理"或手机端。卡片点开跳到对应工件。</UiHelpTip></span>
    </template>
    <template #extra>
      <a-space>
        <a-select v-model:value="wo" :options="woOptions" show-search option-filter-prop="label" style="width: 260px" />
        <a-select v-model:value="supplierId" :options="supplierOptions" show-search option-filter-prop="label" style="width: 200px" />
        <UiRefreshButton @click="refresh()" />
      </a-space>
    </template>
    <a-spin :spinning="pending">
      <a-empty v-if="!total" description="没有符合条件的工序" />
      <div v-else class="board">
        <section v-for="col in columns" :key="col.key" class="col" :aria-label="COLUMN_TEXT[col.key]">
          <header class="col-head">
            <UiStatusTag :tone="COLUMN_TONE[col.key]">{{ COLUMN_TEXT[col.key] }}</UiStatusTag>
            <span class="count">{{ col.cards.length }}</span>
            <UiHelpTip>{{ COLUMN_HELP[col.key] }}</UiHelpTip>
          </header>
          <div class="ft-well col-body">
            <p v-if="!col.cards.length" class="empty">无</p>
            <NuxtLink v-for="c in col.cards" :key="c.stepId" :to="partLink(c)" class="card" :class="{ late: c.overdueDays > 0 }">
              <div class="card-top">
                <span class="wo">{{ c.workOrderNumber }}</span>
                <UiStatusTag v-if="c.overdueDays > 0" tone="late">超期 {{ c.overdueDays }} 天</UiStatusTag>
                <UiStatusTag v-if="c.held" tone="upstream">等变更</UiStatusTag>
              </div>
              <div class="name">{{ c.partName }} · {{ c.seq }}. {{ c.processName }}</div>
              <div class="meta">{{ modeText(c) }} · {{ c.doneQty ? `${c.doneQty}/` : '' }}{{ c.quantity }} 件</div>
              <div class="meta">{{ c.ownerName ?? '未指定负责人' }} · {{ dateLine(c) }}</div>
            </NuxtLink>
          </div>
        </section>
      </div>
    </a-spin>
  </a-card>
</template>

<style scoped>
/* 五列等宽，1440 宽屏幕一屏放下；窄屏横向排成可滑动的列 */
.board { display: grid; grid-template-columns: repeat(5, minmax(200px, 1fr)); gap: 12px; overflow-x: auto; }
.col { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.col-head { display: flex; align-items: center; gap: 8px; }
.count { font-size: 14px; font-weight: 600; color: var(--ft-text); }
.col-body { display: flex; flex-direction: column; gap: 8px; min-height: 120px; }
.empty { margin: 8px 0; color: var(--ft-text-2); font-size: 13px; text-align: center; }
.card { display: block; padding: 10px 12px; background: var(--ft-card-bg); border: 1px solid var(--ft-border); border-radius: 10px; color: var(--ft-text); }
.card:hover { border-color: var(--ft-primary); color: var(--ft-text); }
.card:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; }
.card.late { border-color: var(--ft-late); }
.card-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.wo { font-size: 12px; color: var(--ft-text-2); }
.name { margin-top: 4px; font-size: 14px; font-weight: 500; }
.meta { margin-top: 2px; font-size: 12px; color: var(--ft-text-2); }
</style>
