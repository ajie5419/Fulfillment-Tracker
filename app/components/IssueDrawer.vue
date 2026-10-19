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
  stepId: string | null
  stepStatus: string | null
  category: IssueCategoryKey
  categoryText: string
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

const idRef = computed(() => props.id)
const { data: detail, pending, refresh } = await useAsyncData<Detail | null>(
  'issue-detail',
  () => (idRef.value ? ($fetch as unknown as (u: string) => Promise<Detail>)(`/api/issues/${encodeURIComponent(idRef.value)}`) : Promise.resolve(null)),
  { watch: [idRef] },
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
  const body: Record<string, unknown> = { note: form.note.trim() || undefined }
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
</script>

<template>
  <a-drawer :open="!!id" width="640" :title="detail ? `异常 ${detail.issueNo}` : '异常'" @close="emit('close')">
    <a-spin :spinning="pending">
      <template v-if="detail">
        <a-space wrap style="margin-bottom: 12px">
          <a-tag :color="ISSUE_STATUS_COLOR[detail.status]">{{ ISSUE_STATUS_TEXT[detail.status] }}</a-tag>
          <a-tag>{{ detail.categoryText }}</a-tag>
          <a-tag>{{ ISSUE_SOURCE_TEXT[detail.source] }}</a-tag>
          <a-tag v-if="detail.overdue" color="red">超期{{ detail.overdueDays ? ` ${detail.overdueDays} 天` : '（待受理超时）' }}</a-tag>
        </a-space>
        <p class="desc">{{ detail.description }}</p>
        <a-descriptions :column="2" size="small" bordered>
          <a-descriptions-item label="工单"><WoLink :no="detail.workOrderNumber" /></a-descriptions-item>
          <a-descriptions-item label="关联">
            <NuxtLink v-if="detail.refText" :to="`/parts?wo=${encodeURIComponent(detail.workOrderNumber)}`">{{ detail.refText }}</NuxtLink>
            <span v-else class="muted">—</span>
            <a-tag v-if="detail.stepStatus" :color="STATUS_COLOR[detail.stepStatus as StepStatusKey]" style="margin-left: 6px">{{ STATUS_TEXT[detail.stepStatus as StepStatusKey] }}</a-tag>
          </a-descriptions-item>
          <a-descriptions-item label="责任部门">{{ detail.responsibleDeptName ?? '—' }}</a-descriptions-item>
          <a-descriptions-item label="责任人">{{ detail.responsibleUserName ?? '未指定' }}</a-descriptions-item>
          <a-descriptions-item v-if="detail.responsibleSupplierName" label="外协单位" :span="2">{{ detail.responsibleSupplierName }}</a-descriptions-item>
          <a-descriptions-item label="要求解决日">{{ dayText(detail.dueDate) || '未定（受理时默认 +3 天）' }}</a-descriptions-item>
          <a-descriptions-item label="上报">{{ detail.reporterName ?? '系统' }}　{{ timeText(detail.createdAt) }}</a-descriptions-item>
        </a-descriptions>

        <div v-if="detail.photos.length" class="photos">
          <a-image-preview-group>
            <a-image v-for="p in detail.photos" :key="p.id" :src="p.url" :width="120" :height="120" style="object-fit: cover" />
          </a-image-preview-group>
        </div>

        <a-space wrap class="actions">
          <template v-for="a in actions" :key="a">
            <a-button v-if="detail.can[a]" :type="a === 'reassign' || a === 'reject' ? 'default' : 'primary'" @click="open(a)">{{ ACTION_TEXT[a] }}</a-button>
          </template>
          <a-button @click="open('note')">加备注</a-button>
        </a-space>

        <a-divider orientation="left">处理日志</a-divider>
        <a-timeline>
          <a-timeline-item v-for="l in detail.logs" :key="l.id" :color="l.toStatus === 'CLOSED' ? 'green' : l.toStatus ? 'blue' : 'gray'">
            <div>{{ timeText(l.createdAt) }}　<b>{{ logText(l) }}</b>　<span class="muted">{{ l.actorName }}</span></div>
            <div v-if="l.note" class="note">{{ l.note }}</div>
          </a-timeline-item>
        </a-timeline>
      </template>
    </a-spin>

    <a-modal :open="form.open" :title="ACTION_TEXT[form.action]" :confirm-loading="saving" ok-text="提交" @ok="submit" @cancel="form.open = false">
      <a-form layout="vertical">
        <template v-if="withAssign">
          <a-form-item label="责任部门">
            <a-select v-model:value="form.responsibleDeptId" allow-clear :options="options.departments.map((d) => ({ value: d.id, label: d.name }))" placeholder="选择部门（换部门不选人时默认该部门负责人）" />
          </a-form-item>
          <a-form-item label="责任人">
            <a-select v-model:value="form.responsibleUserId" allow-clear show-search option-filter-prop="label" :options="master.users.map((u) => ({ value: u.id, label: `${u.name}（${u.department}）` }))" />
          </a-form-item>
          <a-form-item v-if="supplierAllowed" label="外协单位">
            <a-select v-model:value="form.responsibleSupplierId" allow-clear show-search option-filter-prop="label" :options="master.suppliers.map((s) => ({ value: s.id, label: s.label }))" />
          </a-form-item>
          <a-form-item label="要求解决日" :extra="form.action === 'accept' ? '不填时默认受理当天 + 3 天' : undefined">
            <a-date-picker v-model:value="form.dueDate" value-format="YYYY-MM-DD" style="width: 100%" />
          </a-form-item>
        </template>
        <a-form-item :label="form.action === 'resolve' ? '处理结果' : form.action === 'reject' ? '退回原因' : '说明'" :required="NOTE_REQUIRED.includes(form.action)">
          <a-textarea v-model:value="form.note" :rows="3" :maxlength="1000" />
        </a-form-item>
      </a-form>
    </a-modal>
  </a-drawer>
</template>

<style scoped>
.desc { font-size: 15px; white-space: pre-wrap; }
.photos { margin-top: 12px; display: flex; gap: 8px; }
.photos :deep(.ant-image) { margin-right: 8px; }
.actions { margin-top: 16px; }
.muted { color: #999; }
.note { color: #555; white-space: pre-wrap; }
</style>
