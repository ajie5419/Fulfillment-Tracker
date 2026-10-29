<script setup lang="ts">
/**
 * 工件抽屉（生产管理重设计第一批，全站共用的工件详情）：
 *   概览：图号 / 版号 / 数量、来源（图纸 BOM / QMS BOM）和 QMS 关联、开工前提（物料、设计还缺几项）、只读工序进度、关联记录数；
 *   时间线：建档、设计、物料、流转、异常、留言（新的在上）；留言：@人。
 * 操作只有两个：上报异常、去编排（在工序编排页里直接打开编排抽屉，别处跳过去）。开工完工在生产调度 / 外协 / 手机端做。
 * 生产调度、工序编排、外协页点工件名打开它；全局搜索、留言提醒跳到 /parts?wo=&part=（带 comments=1 直接开留言）。
 */
import { chainTones, type ChainTone } from '#shared/production'
import { factoryDay } from '#shared/mobile-todo'
import type { PartDetail } from '~~/server/services/flow/steps'

const props = defineProps<{ partId: string | null; tab?: 'info' | 'timeline' | 'comments' }>()
const emit = defineEmits<{ close: []; changed: []; edit: [part: { id: string; workOrderNumber: string }] }>()

const tab = ref<'info' | 'timeline' | 'comments'>('info')
watch(() => props.partId, (id) => { if (id) tab.value = props.tab ?? 'info' }, { immediate: true })

const { data: part, pending, refresh, error } = await useFetch<PartDetail>(() => `/api/parts/${props.partId}`, { immediate: !!props.partId, watch: false })
const { data: timeline, pending: tlPending, refresh: refreshTimeline } = await useFetch(() => `/api/parts/${props.partId}/timeline`, { immediate: false, watch: false })
watch(() => props.partId, (id) => {
  // 切到别的工件：先清掉上一个工件的内容和弹窗，避免加载期间看到 / 点到旧工件
  part.value = undefined
  timeline.value = undefined
  reporting.value = false
  if (!id) return
  refresh()
  if (tab.value === 'timeline') refreshTimeline()
})
watch(tab, (t) => { if (t === 'timeline' && props.partId) refreshTimeline() })

const today = factoryDay(new Date())
const tones = computed(() => (part.value ? chainTones(part.value.steps, today) : []))
const TONE: Record<ChainTone, 'done' | 'primary' | 'late' | 'none'> = { done: 'done', current: 'primary', late: 'late', blocked: 'late', todo: 'none' }
const KIND_TEXT = { part: '建档', drawing: '设计', purchase: '物料', flow: '流转', issue: '异常', comment: '留言' } as const
const related = computed(() => {
  const r = part.value?.related
  if (!r) return []
  return [
    { key: 'd', label: '设计任务', text: r.drawings ? `${r.drawingsDone}/${r.drawings} 完成` : '无', tone: r.drawings && r.drawingsDone === r.drawings ? 'done' : r.drawings ? 'primary' : 'none' },
    { key: 'p', label: '关键物料', text: r.purchases ? `${r.purchasesArrived}/${r.purchases} 到货` : '无', tone: r.purchases && r.purchasesArrived === r.purchases ? 'done' : r.purchases ? 'primary' : 'none' },
    { key: 'i', label: '未关闭异常', text: r.openIssues ? `${r.openIssues} 条` : '无', tone: r.openIssues ? 'late' : 'none' },
    { key: 'c', label: '留言', text: r.comments ? `${r.comments} 条` : '无', tone: 'none' },
  ] as const
})
const route = useRoute()
const onPartsPage = computed(() => route.path === '/parts')
function goEdit() {
  if (!part.value) return
  emit('edit', { id: part.value.id, workOrderNumber: part.value.workOrderNumber })
  if (!onPartsPage.value) navigateTo({ path: '/parts', query: { wo: part.value.workOrderNumber, edit: part.value.id } })
}
const reporting = ref(false)
function onReported(issue: { id: string }) {
  reporting.value = false
  navigateTo({ path: '/issues', query: { id: issue.id } })
}
async function onCommented() {
  emit('changed')
  await refresh()
}
const stepWhere = (s: { mode: StepModeKey; supplierName: string | null }) => (s.mode === 'SELF' ? `自制${s.supplierName ? ` · ${s.supplierName}` : ''}` : `${MODE_TEXT[s.mode]} · ${s.supplierName ?? '未选外协厂'}`)
const stepDates = (s: { planStartDate: string | Date | null; dueDate: string | Date | null }) =>
  [s.planStartDate ? `应开工 ${dayText(s.planStartDate)}` : '', s.dueDate ? `要求完成 ${dayText(s.dueDate)}` : ''].filter(Boolean).join(' · ') || '未定日期'
</script>

<template>
  <a-drawer :open="!!partId" :title="part?.name ?? ''" :width="560" destroy-on-close @close="emit('close')">
    <template #extra>
      <a-space>
        <a-button v-if="part" size="small" danger @click="reporting = true">上报异常</a-button>
        <a-button v-if="part" size="small" type="primary" @click="goEdit">去编排</a-button>
      </a-space>
    </template>
    <a-segmented v-model:value="tab" :options="[{ value: 'info', label: '概览' }, { value: 'timeline', label: '时间线' }, { value: 'comments', label: '留言' }]" class="tabs" />

    <a-spin v-if="tab === 'info'" :spinning="pending">
      <p v-if="error" class="empty">{{ apiError(error) }}</p>
      <template v-else-if="part">
        <div class="ft-well info">
          <div class="kv"><span class="k">工单</span><WoLink :no="part.workOrderNumber" /></div>
          <div class="kv"><span class="k">图号</span><span>{{ part.drawingNo || '—' }}{{ part.revision ? `（${part.revision} 版）` : '' }}</span></div>
          <div class="kv"><span class="k">数量</span><span>{{ part.quantity }} 件</span></div>
          <div class="kv"><span class="k">来源</span>
            <span class="tags">
              <UiStatusTag v-if="part.fromTechBom" tone="none">来自图纸 BOM</UiStatusTag>
              <UiStatusTag v-else-if="part.qmsBomId" tone="none">来自 QMS BOM</UiStatusTag>
              <UiStatusTag v-else tone="none">手工新建</UiStatusTag>
              <UiStatusTag v-if="part.qmsBomId && part.fromTechBom" tone="done">已关联 QMS</UiStatusTag>
              <UiStatusTag v-else-if="part.fromTechBom" tone="risk">未关联 QMS</UiStatusTag>
            </span>
          </div>
          <div class="kv"><span class="k">QMS 物料 ID</span><span>{{ part.qmsPartId || '—' }}</span></div>
          <div v-if="part.prereq.tracked" class="kv"><span class="k">开工前提</span>
            <span class="tags">
              <UiStatusTag :tone="part.prereq.missingMaterial ? 'risk' : 'done'">{{ part.prereq.missingMaterial ? `缺料 ${part.prereq.missingMaterial} 项` : '物料齐' }}</UiStatusTag>
              <UiStatusTag :tone="part.prereq.missingDrawing ? 'risk' : 'done'">{{ part.prereq.missingDrawing ? `缺图 ${part.prereq.missingDrawing} 项` : '图纸齐' }}</UiStatusTag>
              <UiStatusTag :tone="part.prereq.missingMaterialList ? 'risk' : 'done'">{{ part.prereq.missingMaterialList ? '料单未下发' : '料单已下发' }}</UiStatusTag>
            </span>
          </div>
        </div>

        <h3 class="sec">工序进度</h3>
        <p v-if="!part.steps.length" class="empty">还没排工序，点右上角"去编排"。</p>
        <ol v-else class="steps">
          <li v-for="(s, i) in part.steps" :key="s.id" class="step">
            <span class="seq">{{ s.seq }}</span>
            <div class="step-main">
              <div class="step-name">{{ s.processName }}<span class="muted"> · {{ stepWhere(s) }}</span></div>
              <div class="muted">{{ s.ownerName ?? (s.leaderName ? `班组长 ${s.leaderName}` : '未指定负责人') }} · {{ stepDates(s) }}{{ s.returnedQty ? ` · 已完成 ${s.returnedQty}/${part.quantity}` : '' }}</div>
              <div v-if="s.issues.length" class="muted">
                异常：<NuxtLink v-for="x in s.issues" :key="x.id" :to="`/issues?id=${encodeURIComponent(x.id)}`" class="issue">{{ x.issueNo }}</NuxtLink>
              </div>
            </div>
            <span class="tags">
              <UiStatusTag :tone="TONE[tones[i]!]">{{ tones[i] === 'late' ? '超期' : STATUS_TEXT[s.status] }}</UiStatusTag>
              <UiStatusTag v-if="s.holdReleaseId && s.status === 'PENDING'" tone="upstream">等变更</UiStatusTag>
            </span>
          </li>
        </ol>

        <h3 class="sec">关联记录</h3>
        <div class="related">
          <div v-for="r in related" :key="r.key" class="rel">
            <span class="muted">{{ r.label }}</span>
            <UiStatusTag :tone="r.tone">{{ r.text }}</UiStatusTag>
          </div>
        </div>
      </template>
    </a-spin>

    <a-spin v-else-if="tab === 'timeline'" :spinning="tlPending">
      <p v-if="!timeline?.entries.length" class="empty">还没有记录</p>
      <ol v-else class="tl">
        <li v-for="(e, i) in timeline.entries" :key="i" class="tl-item">
          <span class="dot" :style="{ background: `var(--ft-${e.tone})` }" aria-hidden="true" />
          <div class="tl-main">
            <div class="tl-head">
              <UiStatusTag :tone="e.tone">{{ KIND_TEXT[e.kind] }}</UiStatusTag>
              <NuxtLink v-if="e.link" :to="e.link" class="tl-title">{{ e.title }}</NuxtLink>
              <span v-else class="tl-title">{{ e.title }}</span>
            </div>
            <div v-if="e.sub" class="tl-sub">{{ e.sub }}</div>
            <div class="tl-time">{{ timeText(e.at) }}</div>
          </div>
        </li>
      </ol>
    </a-spin>

    <CommentPanel v-else-if="partId" ref-type="part" :ref-id="partId" @changed="onCommented" />

    <IssueReportModal :open="reporting" :work-order-number="part?.workOrderNumber" :part-id="partId ?? undefined" @close="reporting = false" @done="onReported" />
  </a-drawer>
</template>

<style scoped>
.tabs { margin-bottom: 16px; }
.empty { margin: 8px 0; color: var(--ft-text-2); font-size: 13px; }
.info { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.kv { display: grid; grid-template-columns: 88px 1fr; gap: 8px; align-items: center; }
.k { color: var(--ft-text-2); }
.tags { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.sec { margin: 16px 0 8px; font-size: 14px; font-weight: 600; }
.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.step { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 8px 10px; border: 1px solid var(--ft-border); border-radius: 10px; }
.seq { color: var(--ft-text-2); font-size: 12px; line-height: 22px; }
.step-name { font-size: 14px; }
.muted { color: var(--ft-text-2); font-size: 12px; }
.issue { color: var(--ft-late-text); margin-right: 6px; }
.related { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.rel { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; background: var(--ft-fill); border-radius: 10px; }
.tl { list-style: none; margin: 0; padding: 0; }
.tl-item { position: relative; display: flex; gap: 12px; padding: 0 0 16px; }
.tl-item:not(:last-child)::before { content: ''; position: absolute; left: 4px; top: 14px; bottom: 0; width: 1px; background: var(--ft-border); }
.dot { flex: none; width: 9px; height: 9px; margin-top: 6px; border-radius: 50%; }
.tl-main { flex: 1; min-width: 0; }
.tl-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tl-title { font-size: 14px; color: var(--ft-text); }
a.tl-title { color: var(--ft-primary); }
.tl-sub { margin-top: 2px; font-size: 13px; color: var(--ft-text); word-break: break-word; }
.tl-time { margin-top: 2px; font-size: 12px; color: var(--ft-text-2); }
</style>
