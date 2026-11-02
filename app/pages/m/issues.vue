<script setup lang="ts">
import { toneOfVant } from '#shared/mobile-todo'

/**
 * 手机"我的异常"：等我处理 / 我负责 / 我上报。点开看详情（照片、处理日志），按权限受理、填处理结果、确认关闭、退回。
 * 改派在电脑端异常列表里做。带 ?id= 直接打开某条（提醒、上报后跳过来）。
 */
definePageMeta({ layout: 'mobile' })
const route = useRoute()
const router = useRouter()

const tab = ref<string>((route.query.tab as string) || 'todo')
const { data: rows, pending, error, refresh } = await useFetch('/api/issues', {
  query: computed(() => ({ mine: tab.value, status: tab.value === 'todo' ? 'UNCLOSED' : undefined, dept: '0' })),
  default: () => [],
})

type Detail = {
  id: string
  issueNo: string
  workOrderNumber: string
  refText: string | null
  categoryText: string
  title: string | null
  description: string
  source: keyof typeof ISSUE_SOURCE_TEXT
  reporterName: string | null
  responsibleDeptName: string | null
  responsibleUserName: string | null
  responsibleSupplierName: string | null
  dueDate: string | null
  status: IssueStatusKey
  createdAt: string
  overdue: boolean
  overdueDays: number
  can: Record<IssueAction, boolean>
  photos: { id: string; url: string }[]
  logs: { id: string; fromStatus: IssueStatusKey | null; toStatus: IssueStatusKey | null; note: string | null; actorName: string; createdAt: string }[]
}
const requestFetch = useRequestFetch()
const selected = ref<string | null>((route.query.id as string) || null)
const { data: detail, pending: detailPending, error: detailError, refresh: refreshDetail } = await useAsyncData<Detail | null>(
  computed(() => `m-issue-detail:${selected.value ?? 'closed'}`),
  () => (selected.value ? clientRequest(`/api/issues/${encodeURIComponent(selected.value)}`, undefined, requestFetch) : Promise.resolve(null)),
  { default: () => null },
)
watch([tab, selected], ([t, id]) => {
  if (import.meta.client) router.replace({ query: { tab: t, id: id || undefined } })
})

// ───── 操作 ─────
const acting = ref<IssueAction | null>(null)
watch(() => route.query.id, (id) => { selected.value = typeof id === 'string' ? id : null })
watch(selected, () => { acting.value = null })
const note = ref('')
const NOTE_LABEL: Partial<Record<IssueAction, string>> = { resolve: '处理结果', reject: '退回原因', close: '说明（可不填）', accept: '说明（可不填）' }
function startAction(a: IssueAction) {
  acting.value = a
  note.value = ''
}
async function doAction() {
  const a = acting.value
  const d = detail.value
  if (!a || !d) return
  if (NOTE_REQUIRED.includes(a) && !note.value.trim()) {
    showToast(`请填写${NOTE_LABEL[a] ?? '说明'}`)
    return
  }
  try {
    await issueAction(d.id, a, { note: note.value.trim() || undefined })
    showSuccessToast(`已${ACTION_TEXT[a]}`)
    acting.value = null
    await Promise.all([refreshDetail(), refresh()])
  } catch (e) {
    showFailToast(apiError(e))
  }
}
const mobileActions: IssueAction[] = ['accept', 'resolve', 'close', 'reject']
const logText = (l: Detail['logs'][number]) =>
  l.toStatus && l.fromStatus ? `${ISSUE_STATUS_TEXT[l.fromStatus]} → ${ISSUE_STATUS_TEXT[l.toStatus]}` : l.toStatus ? ISSUE_STATUS_TEXT[l.toStatus] : '备注 / 改派'
</script>

<template>
  <div>
    <van-nav-bar title="我的异常">
      <template #right>
        <van-button size="small" type="danger" round icon="plus" @click="navigateTo('/m/issue-new')">上报</van-button>
      </template>
    </van-nav-bar>
    <van-tabs v-model:active="tab">
      <van-tab title="等我处理" name="todo" />
      <van-tab title="我负责" name="responsible" />
      <van-tab title="我上报" name="reported" />
    </van-tabs>
    <van-loading v-if="pending" class="m-center" />
    <van-empty v-else-if="error" image="error" description="列表加载失败"><van-button size="small" @click="refresh()">重试</van-button></van-empty>
    <van-empty v-else-if="!rows.length" description="没有异常" image-size="80" />
    <div v-else class="m-list">
      <MCard v-for="r in rows" :key="r.id" :tone="r.overdue ? 'late' : toneOfVant(ISSUE_STATUS_TYPE[r.status as IssueStatusKey])" link @click="selected = r.id">
        <div class="m-row">
          <van-tag :type="ISSUE_STATUS_TYPE[r.status as IssueStatusKey]">{{ ISSUE_STATUS_TEXT[r.status as IssueStatusKey] }}</van-tag>
          <van-tag v-if="r.overdue" type="danger">超期</van-tag>
          <span class="no">{{ r.issueNo }}</span>
        </div>
        <div v-if="r.title" class="m-title">{{ r.title }}</div>
        <div class="m-desc clamp desc">{{ r.description }}</div>
        <div class="m-meta">
          <span>{{ r.workOrderNumber }}</span>
          <span>{{ r.categoryText }}</span>
          <span v-if="r.responsibleUserName ?? r.responsibleDeptName">{{ r.responsibleUserName ?? r.responsibleDeptName }}</span>
        </div>
      </MCard>
    </div>
    <div class="m-foot" />

    <van-popup :show="!!selected" position="bottom" round closeable :style="{ height: '85%' }" @update:show="(v: boolean) => { if (!v) selected = null }">
      <van-loading v-if="detailPending" class="m-center" />
      <van-empty v-else-if="detailError" image="error" description="异常加载失败"><van-button size="small" @click="refreshDetail()">重试</van-button></van-empty>
      <div v-else-if="detail && detail.id === selected" class="detail">
        <div class="detail-head">
          <span class="detail-no">{{ detail.issueNo }}</span>
          <van-tag :type="ISSUE_STATUS_TYPE[detail.status]">{{ ISSUE_STATUS_TEXT[detail.status] }}</van-tag>
          <van-tag v-if="detail.overdue" type="danger">超期</van-tag>
        </div>
        <div v-if="detail.title" class="m-title">{{ detail.title }}</div>
        <p class="desc-full">{{ detail.description }}</p>
        <van-cell-group inset class="info">
          <van-cell title="工单" :value="detail.workOrderNumber" />
          <van-cell v-if="detail.refText" title="关联" :value="detail.refText" />
          <van-cell title="分类 / 来源" :value="`${detail.categoryText} / ${ISSUE_SOURCE_TEXT[detail.source]}`" />
          <van-cell title="责任" :value="`${detail.responsibleDeptName ?? '—'} / ${detail.responsibleUserName ?? '未指定'}`" :label="detail.responsibleSupplierName ?? ''" />
          <van-cell title="要求解决日" :value="dayText(detail.dueDate) || '受理时默认 +3 天'" :label="detail.overdue ? (detail.overdueDays ? `已超期 ${detail.overdueDays} 天` : '待受理超时') : ''" />
          <van-cell title="上报" :value="detail.reporterName ?? '系统'" :label="timeText(detail.createdAt)" />
        </van-cell-group>
        <div v-if="detail.photos.length" class="photos">
          <van-image v-for="p in detail.photos" :key="p.id" :src="p.url" width="96" height="96" fit="cover" radius="10" @click="showImagePreview(detail.photos.map((x) => x.url))" />
        </div>
        <div class="actions">
          <template v-for="a in mobileActions" :key="a">
            <van-button v-if="detail.can[a]" :type="a === 'reject' ? 'default' : 'primary'" size="small" round @click="startAction(a)">{{ ACTION_TEXT[a] }}</van-button>
          </template>
        </div>
        <div class="section">处理日志</div>
        <van-steps direction="vertical" :active="detail.logs.length - 1">
          <van-step v-for="l in detail.logs" :key="l.id">
            <div><b>{{ logText(l) }}</b>　{{ l.actorName }}</div>
            <div v-if="l.note" class="note">{{ l.note }}</div>
            <div class="m-muted small">{{ timeText(l.createdAt) }}</div>
          </van-step>
        </van-steps>
      </div>
    </van-popup>

    <van-dialog :show="!!acting" :title="acting ? ACTION_TEXT[acting] : ''" show-cancel-button @confirm="doAction" @cancel="acting = null">
      <van-field v-model="note" type="textarea" rows="3" autosize maxlength="1000" :placeholder="acting ? NOTE_LABEL[acting] : ''" />
      <p v-if="acting === 'accept'" class="m-muted small dialog-hint">受理后要求解决日默认为今天 + 3 天（已有的不变）</p>
    </van-dialog>
  </div>
</template>

<style scoped>
.no { font-size: 13px; font-weight: 600; color: var(--ft-text-2); }
.desc { font-size: 14px; font-weight: 500; margin-top: 6px; }
.detail { padding: 16px 4px; background: var(--ft-page-bg); min-height: 100%; box-sizing: border-box; }
.detail-head { display: flex; align-items: center; gap: 8px; padding: 0 44px 0 12px; flex-wrap: wrap; }
.detail-no { font-size: 18px; font-weight: 600; }
.desc-full { margin: 10px 12px 12px; padding: 12px 14px; background: var(--ft-card-bg); border: 1px solid var(--ft-border); border-radius: var(--ft-card-radius); font-size: 15px; line-height: 22px; white-space: pre-wrap; overflow-wrap: anywhere; }
.photos { display: flex; gap: 8px; padding: 12px; flex-wrap: wrap; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px; }
.actions .van-button { min-width: 72px; }
.section { padding: 12px 16px 4px; color: var(--ft-text); font-weight: 600; font-size: 14px; }
.detail :deep(.van-steps) { margin: 0 12px; border-radius: var(--ft-card-radius); }
.note { color: var(--ft-text-2); white-space: pre-wrap; }
.small { font-size: 12px; }
.dialog-hint { padding: 0 16px 12px; }
</style>
