<script setup lang="ts">
/** 电脑端异常详情抽屉：基本信息、照片、处理日志时间线，按权限显示 受理/改派/填处理结果/确认关闭/退回/备注 */
const props = defineProps<{ id: string | null }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const { data: master } = await useMaster()
const { data: options } = await useIssueOptions()

type Detail = {
  id: string
  issueNo: string
  workOrderNumber: string
  refText: string | null
  partId: string | null
  stepId: string | null
  stepStatus: string | null
  category: IssueCategoryKey
  categoryText: string
  title: string | null
  description: string
  source: keyof typeof ISSUE_SOURCE_TEXT
  reporterName: string | null
  responsibleDeptId: string | null
  responsibleDeptName: string | null
  responsibleUserId: string | null
  responsibleUserName: string | null
  responsibleSupplierId: string | null
  responsibleSupplierName: string | null
  dueDate: string | null
  status: IssueStatusKey
  createdAt: string
  overdue: boolean
  overdueDays: number
  alertLevel: AlertLevelKey | null
  can: Record<IssueAction, boolean>
  photos: { id: string; url: string }[]
  logs: { id: string; fromStatus: IssueStatusKey | null; toStatus: IssueStatusKey | null; note: string | null; actorName: string; createdAt: string }[]
}

// 深链 SSR 也必须转发当前登录 Cookie；普通 apiFetch 在服务端不带用户请求头。
const requestFetch = useApiRequestFetch()
const idRef = computed(() => props.id)
const { data: detail, pending, error: detailError, refresh } = await useAsyncData<Detail | null>(
  computed(() => `issue-detail:${idRef.value ?? 'closed'}`),
  () => (idRef.value ? clientRequest(`/api/issues/${encodeURIComponent(idRef.value)}`, undefined, requestFetch) : Promise.resolve(null)),
  { default: () => null },
)

// ───── 操作弹窗 ─────
const form = reactive({
  open: false,
  action: 'accept' as IssueAction,
  note: '',
  responsibleDeptId: undefined as string | undefined,
  responsibleUserId: undefined as string | undefined,
  responsibleSupplierId: undefined as string | undefined,
  dueDate: undefined as string | undefined,
})
watch(idRef, () => { form.open = false })
const saving = ref(false)
const withAssign = computed(() => form.action === 'accept' || form.action === 'reassign')
const supplierAllowed = computed(() => detail.value?.category === 'OUTSOURCE_SCHEDULE' || detail.value?.category === 'OUTSOURCE_QUALITY')

function open(action: IssueAction) {
  const d = detail.value
  if (!d) return
  Object.assign(form, {
    open: true,
    action,
    note: '',
    responsibleDeptId: d.responsibleDeptId ?? undefined,
    responsibleUserId: d.responsibleUserId ?? undefined,
    responsibleSupplierId: d.responsibleSupplierId ?? undefined,
    dueDate: d.dueDate ? dayText(d.dueDate) : undefined,
  })
}

async function submit() {
  const d = detail.value
  if (!d) return
  if (NOTE_REQUIRED.includes(form.action) && !form.note.trim()) return message.warning(form.action === 'resolve' ? '请填写处理结果' : '请填写说明')
  const body: import('../../server/api/issues/[id]/accept.post').RequestBody = { note: form.note.trim() || undefined }
  if (withAssign.value) {
    // 只提交改了的字段
    if ((form.responsibleDeptId ?? null) !== d.responsibleDeptId) body.responsibleDeptId = form.responsibleDeptId ?? null
    if ((form.responsibleUserId ?? null) !== d.responsibleUserId) body.responsibleUserId = form.responsibleUserId ?? null
    if (supplierAllowed.value && (form.responsibleSupplierId ?? null) !== d.responsibleSupplierId) body.responsibleSupplierId = form.responsibleSupplierId ?? null
    if ((form.dueDate ?? null) !== (d.dueDate ? dayText(d.dueDate) : null)) body.dueDate = form.dueDate ?? null
  }
  if (form.action === 'note' || form.action === 'resolve' || form.action === 'reject') body.note = form.note.trim()
  saving.value = true
  try {
    await issueAction(d.id, form.action, body)
    message.success(`已${ACTION_TEXT[form.action]}`)
    form.open = false
    await refresh()
    emit('changed')
  } catch (e) {
    message.error(apiError(e))
  } finally {
    saving.value = false
  }
}

const logText = (l: Detail['logs'][number]) =>
  l.toStatus && l.fromStatus ? `${ISSUE_STATUS_TEXT[l.fromStatus]} → ${ISSUE_STATUS_TEXT[l.toStatus]}` : l.toStatus ? ISSUE_STATUS_TEXT[l.toStatus] : '备注 / 改派'
const actions: IssueAction[] = ['accept', 'resolve', 'close', 'reject', 'reassign']
const FLOW_STEPS: IssueStatusKey[] = ['OPEN', 'ACCEPTED', 'RESOLVED', 'CLOSED']
const stepIndex = computed(() => (detail.value ? FLOW_STEPS.indexOf(detail.value.status) : 0))
</script>

<template>
  <a-drawer :open="!!id" width="640" @close="emit('close')">
    <template #title>
      <div class="drawer-title">
        <span>{{ detail ? `异常 ${detail.issueNo}` : '异常' }}</span>
        <a-tag v-if="detail?.overdue" color="red" class="tag">超期{{ detail.overdueDays ? ` ${detail.overdueDays} 天` : '（待受理超时）' }}</a-tag>
      </div>
    </template>

    <a-spin :spinning="pending">
      <a-result v-if="detailError" status="error" title="异常加载失败"><template #extra><a-button @click="refresh()">重试</a-button></template></a-result>
      <template v-else-if="detail && detail.id === id">
        <div class="drawer-body">
          <!-- 闭环进度条 -->
          <div class="steps" role="list" aria-label="异常闭环进度">
            <div v-for="(s, idx) in FLOW_STEPS" :key="s" class="step" :class="{ done: idx < stepIndex, active: idx === stepIndex }" role="listitem">
              <span class="step-num">{{ idx < stepIndex ? '✓' : idx + 1 }}</span>
              <span>{{ ISSUE_STATUS_TEXT[s] }}</span>
            </div>
          </div>

          <!-- 标题与描述 -->
          <div>
            <h3 v-if="detail.title" class="issue-title">{{ detail.title }}</h3>
            <p class="desc">{{ detail.description }}</p>
            <div class="sub-tags">
              <span class="chip">{{ detail.categoryText }}</span>
              <span class="chip">{{ ISSUE_SOURCE_TEXT[detail.source] }}</span>
            </div>
          </div>

          <!-- 元数据托盘卡 -->
          <div class="tray">
            <div class="inset">
              <div class="meta-grid">
                <div class="meta-item"><span class="meta-k">工单</span><span class="meta-v"><WoLink :no="detail.workOrderNumber" /></span></div>
                <div class="meta-item">
                  <span class="meta-k">要求解决日</span>
                  <span class="meta-v" :class="{ late: detail.overdue }">{{ dayText(detail.dueDate) || '未定（受理时默认 +3 天）' }}</span>
                </div>
                <div class="meta-item"><span class="meta-k">责任部门</span><span class="meta-v">{{ detail.responsibleDeptName ?? '—' }}</span></div>
                <div class="meta-item"><span class="meta-k">责任人</span><span class="meta-v">{{ detail.responsibleUserName ?? '未指定' }}</span></div>
                <div v-if="detail.refText" class="meta-item span-2">
                  <span class="meta-k">关联对象</span>
                  <span class="meta-v">
                    <NuxtLink :to="detail.partId ? `/parts?wo=${encodeURIComponent(detail.workOrderNumber)}&part=${encodeURIComponent(detail.partId)}` : `/parts?wo=${encodeURIComponent(detail.workOrderNumber)}`">{{ detail.refText }}</NuxtLink>
                    <a-tag v-if="detail.stepStatus" :color="STATUS_COLOR[detail.stepStatus as StepStatusKey]" style="margin-left: 6px">{{ STATUS_TEXT[detail.stepStatus as StepStatusKey] }}</a-tag>
                  </span>
                </div>
                <div v-if="detail.responsibleSupplierName" class="meta-item span-2"><span class="meta-k">外协单位</span><span class="meta-v">{{ detail.responsibleSupplierName }}</span></div>
                <div class="meta-item span-2"><span class="meta-k">上报</span><span class="meta-v">{{ detail.reporterName ?? '系统' }} · {{ timeText(detail.createdAt) }}</span></div>
              </div>
            </div>
          </div>

          <div v-if="detail.photos.length" class="photos">
            <a-image-preview-group>
              <a-image v-for="p in detail.photos" :key="p.id" :src="p.url" :width="112" :height="112" style="object-fit: cover; border-radius: 8px" />
            </a-image-preview-group>
          </div>

          <!-- 操作按钮 -->
          <div class="actions">
            <template v-for="a in actions" :key="a">
              <a-button
                v-if="detail.can[a]"
                :type="a === 'reassign' || a === 'reject' ? 'default' : 'primary'"
                :class="{ 'ft-btn-ink': a !== 'reassign' && a !== 'reject' }"
                @click="form.open && form.action === a ? (form.open = false) : open(a)"
              >
                {{ ACTION_TEXT[a] }}
              </a-button>
            </template>
            <a-button @click="form.open && form.action === 'note' ? (form.open = false) : open('note')">加备注</a-button>
          </div>

          <!-- 抽屉内联处置表单（不弹第二层 Modal） -->
          <div v-if="form.open" class="inline-panel">
            <div class="inline-head">
              <span>{{ ACTION_TEXT[form.action] }}</span>
              <a-button type="text" size="small" @click="form.open = false">收起</a-button>
            </div>
            <a-form layout="vertical" size="small">
              <div v-if="withAssign" class="form-grid">
                <a-form-item label="责任部门">
                  <a-select v-model:value="form.responsibleDeptId" allow-clear :options="options.departments.map((d) => ({ value: d.id, label: d.name }))" placeholder="选择部门（不选人时默认部门负责人）" />
                </a-form-item>
                <a-form-item label="责任人">
                  <a-select v-model:value="form.responsibleUserId" allow-clear show-search option-filter-prop="label" :options="master.users.map((u) => ({ value: u.id, label: `${u.name}（${u.department}）` }))" />
                </a-form-item>
                <a-form-item v-if="supplierAllowed" label="外协单位">
                  <a-select v-model:value="form.responsibleSupplierId" allow-clear show-search option-filter-prop="label" :options="master.suppliers.map((s) => ({ value: s.id, label: s.label }))" />
                </a-form-item>
                <a-form-item label="要求解决日" :extra="form.action === 'accept' ? '不填时默认受理当天 + 3 天' : undefined">
                  <UiDatePicker v-model:value="form.dueDate" style="width: 100%" />
                </a-form-item>
              </div>
              <a-form-item :label="form.action === 'resolve' ? '处理结果' : form.action === 'reject' ? '退回原因' : '说明'" :required="NOTE_REQUIRED.includes(form.action)" style="margin-bottom: 10px">
                <a-textarea v-model:value="form.note" :rows="3" :maxlength="1000" placeholder="填写处理说明..." />
              </a-form-item>
              <div class="inline-foot">
                <a-button size="small" @click="form.open = false">取消</a-button>
                <a-button size="small" type="primary" class="ft-btn-ink" :loading="saving" @click="submit">确认提交</a-button>
              </div>
            </a-form>
          </div>

          <!-- 流转记录托盘卡 -->
          <div class="tray">
            <div class="tray-head">
              <span>处理日志</span>
              <span v-if="detail.logs.length" class="muted">{{ detail.logs.length }} 条</span>
            </div>
            <div class="inset">
              <div v-if="!detail.logs.length" class="empty-log">暂无流转记录，受理后将自动记录处理轨迹</div>
              <a-timeline v-else style="margin-top: 4px; margin-bottom: -12px">
                <a-timeline-item v-for="l in detail.logs" :key="l.id" :color="l.toStatus === 'CLOSED' ? 'green' : l.toStatus ? 'blue' : 'gray'">
                  <div>{{ timeText(l.createdAt) }}　<b>{{ logText(l) }}</b>　<span class="muted">{{ l.actorName }}</span></div>
                  <div v-if="l.note" class="note">{{ l.note }}</div>
                </a-timeline-item>
              </a-timeline>
            </div>
          </div>
        </div>
      </template>
    </a-spin>
  </a-drawer>
</template>

<style scoped>
.drawer-title { display: flex; align-items: center; gap: 8px; }
.drawer-body { display: flex; flex-direction: column; gap: 14px; }
.tag { margin-inline-end: 0; }
.steps { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; background: var(--card-tray-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius-inner); padding: 8px 10px; }
.step { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ft-text-3); }
.step.done { color: var(--ft-done-text); }
.step.active { color: var(--ft-primary-text); font-weight: 600; }
.step-num { width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--ft-border); background: var(--card-surface-bg); display: inline-grid; place-items: center; font-size: 11px; flex: none; font-variant-numeric: tabular-nums; }
.step.done .step-num { background: var(--ft-done-bg); border-color: var(--ft-done-bg); color: var(--ft-done-text); }
.step.active .step-num { background: var(--ft-primary-bg); border-color: var(--ft-primary); color: var(--ft-primary-text); }

.issue-title { margin: 0 0 4px; font-size: 15px; font-weight: 600; color: var(--ft-text); }
.desc { margin: 0; font-size: 14.5px; font-weight: 500; line-height: 1.5; color: var(--ft-text); white-space: pre-wrap; }
.sub-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.chip { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; background: var(--ft-fill); border: 1px solid var(--ft-border); color: var(--ft-text-2); }

.tray { background: var(--card-tray-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius-outer); padding: 8px 6px 6px; }
.tray-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 8px 8px; font-size: 12.5px; font-weight: 600; color: var(--ft-text-2); }
.inset { background: var(--card-surface-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius-inner); padding: 12px 14px; }

.meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; font-size: 13px; }
.meta-item { display: flex; gap: 8px; min-width: 0; }
.meta-item.span-2 { grid-column: span 2; }
.meta-k { color: var(--ft-text-3); flex: none; min-width: 70px; }
.meta-v { color: var(--ft-text); font-variant-numeric: tabular-nums; min-width: 0; word-break: break-word; }
.late { color: var(--ft-late-text); font-weight: 500; }

.photos { display: flex; gap: 8px; flex-wrap: wrap; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }

.inline-panel { background: var(--ft-fill); border: 1px solid var(--ft-primary); border-radius: var(--card-radius-inner); padding: 12px 14px; }
.inline-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-size: 13px; font-weight: 600; color: var(--ft-text); }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 12px; }
.inline-foot { display: flex; justify-content: flex-end; gap: 8px; }

.empty-log { text-align: center; padding: 12px 0; font-size: 12.5px; color: var(--ft-text-3); }
.muted { color: var(--ft-text-2); font-size: 12px; }
.note { color: var(--ft-text-2); white-space: pre-wrap; margin-top: 2px; }

@media (max-width: 575px) {
  .steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .meta-grid, .form-grid { grid-template-columns: minmax(0, 1fr); }
  .meta-item.span-2 { grid-column: auto; }
}
</style>
