<script setup lang="ts">
/** 手机签收页（R9）：看发放内容和附件，签收，或拒收并写原因；收到"确认变更影响"待办的人也在这里确认 */
definePageMeta({ layout: 'mobile' })
const route = useRoute()
const id = computed(() => (route.query.id as string) || '')
const detail = ref<ReleaseDetail | null>(null)
const loadError = ref('')
const loading = ref(false)

async function load() {
  if (!id.value) return
  loading.value = true
  try {
    detail.value = await fetchRelease(id.value)
    loadError.value = ''
  } catch (e) {
    loadError.value = apiError(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(id, load)

const busy = ref(false)
async function act(url: string, body: object, ok: string) {
  busy.value = true
  try {
    await releasePost(url, body)
    showSuccessToast(ok)
    await load()
    await refreshNuxtData(['todos', 'reminders'])
    return true
  } catch (e) {
    showFailToast(apiError(e))
    return false
  } finally {
    busy.value = false
  }
}

async function sign() {
  const d = detail.value
  if (!d?.myReceipt) return
  try {
    await showConfirmDialog({ title: '确认签收', message: `${d.typeText} ${d.releaseNo}${d.version ? `（版本 ${d.version}）` : ''}` })
  } catch {
    return
  }
  await act(`/api/receipts/${d.myReceipt.id}/sign`, {}, '已签收')
}

const rejecting = ref(false)
const reason = ref('')
async function reject() {
  const d = detail.value
  if (!d?.myReceipt) return
  if (!reason.value.trim()) {
    showToast('请填写拒收原因')
    return
  }
  if (await act(`/api/receipts/${d.myReceipt.id}/reject`, { reason: reason.value.trim() }, '已拒收')) {
    rejecting.value = false
    reason.value = ''
  }
}

const confirming = ref(false)
const note = ref('')
async function confirmChange() {
  const d = detail.value
  if (!d) return
  if (await act(`/api/releases/${d.id}/confirm-change`, { note: note.value.trim() || null }, '已确认变更影响')) {
    confirming.value = false
    note.value = ''
  }
}

const images = computed(() => (detail.value?.attachments ?? []).filter((a) => isImage(a.mime)))
const pdfs = computed(() => (detail.value?.attachments ?? []).filter((a) => !isImage(a.mime)))
</script>

<template>
  <div>
    <van-nav-bar :title="detail ? `${detail.typeText} ${detail.releaseNo}` : '发放单'" left-arrow @click-left="navigateTo('/m/releases')" />
    <van-loading v-if="loading && !detail" class="center" />
    <van-empty v-else-if="loadError" :description="loadError" image="error" />
    <template v-else-if="detail">
      <van-notice-bar v-if="detail.status === 'VOID'" color="#ed6a0c" background="#fffbe8" text="这张发放单已作废" />
      <van-notice-bar
        v-else-if="detail.myReceipt && detail.myReceipt.status !== 'PENDING'"
        :color="detail.myReceipt.status === 'SIGNED' ? '#07c160' : '#ee0a24'"
        background="#f7f8fa"
        :text="`你已${RECEIPT_STATUS_TEXT[detail.myReceipt.status].replace('已', '')} ${timeText(detail.myReceipt.actedAt)}${detail.myReceipt.reason ? `：${detail.myReceipt.reason}` : ''}`"
      />
      <div class="body">
        <p class="desc">{{ detail.description }}</p>
      </div>
      <van-cell-group inset>
        <van-cell title="工单" :value="detail.workOrderNumber" :label="detail.projectName ?? detail.customerName ?? ''" />
        <van-cell title="版本号" :value="detail.version ?? '—'" />
        <van-cell title="关联工件" :value="detail.parts.map((p) => p.name).join('、') || '未关联'" />
        <van-cell title="发放人" :value="detail.issuerName ?? ''" :label="timeText(detail.createdAt)" />
        <van-cell title="签收进度" :value="`${detail.counts.SIGNED}/${detail.receipts.length} 已签收`" :label="detail.counts.REJECTED ? `${detail.counts.REJECTED} 人拒收` : ''" />
      </van-cell-group>

      <div class="section">附件</div>
      <div v-if="!detail.attachments.length" class="muted pad">无附件（纸质下发）</div>
      <div v-if="images.length" class="photos">
        <van-image v-for="a in images" :key="a.id" :src="a.url" width="96" height="96" fit="cover" radius="4" @click="showImagePreview(images.map((x) => x.url))" />
      </div>
      <van-cell-group v-if="pdfs.length" inset>
        <van-cell v-for="(a, i) in pdfs" :key="a.id" :title="`PDF 附件 ${i + 1}`" :value="sizeText(a.size)" is-link :url="a.url" />
      </van-cell-group>

      <template v-if="detail.change && detail.change.needsConfirm">
        <div class="section">设计变更影响</div>
        <div class="pad muted">
          {{ detail.change.confirmers.length ? `待 ${detail.change.confirmers.map((c) => c.userName).join('、')} 确认（任一人即可）` : '接收人全部签收后自动解除' }}{{ detail.change.heldSteps ? `；${detail.change.heldSteps} 道未开工工序"等变更"中` : '' }}
        </div>
      </template>

      <div class="actions">
        <template v-if="detail.permissions.sign">
          <van-button type="primary" block round :loading="busy" @click="sign">签收</van-button>
          <van-button type="danger" plain block round :disabled="busy" @click="rejecting = true">拒收</van-button>
        </template>
        <van-button v-if="detail.permissions.confirmChange" type="warning" block round :disabled="busy" @click="confirming = true">确认变更影响</van-button>
      </div>
    </template>

    <van-dialog :show="rejecting" title="拒收原因" show-cancel-button :before-close="() => false" @confirm="reject" @cancel="rejecting = false">
      <van-field v-model="reason" type="textarea" rows="3" autosize maxlength="500" placeholder="如：版本不对，现场是 A 版" />
    </van-dialog>
    <van-dialog :show="confirming" title="确认变更影响" show-cancel-button :before-close="() => false" @confirm="confirmChange" @cancel="confirming = false">
      <p class="muted pad">确认已评估在加工/在外协工序的影响，确认后解除"等变更"。</p>
      <van-field v-model="note" type="textarea" rows="3" autosize maxlength="500" placeholder="处理意见，可空" />
    </van-dialog>
  </div>
</template>

<style scoped>
.center { display: flex; justify-content: center; padding: 32px; }
.body { padding: 12px 16px 0; }
.desc { font-size: 15px; white-space: pre-wrap; margin: 0 0 12px; }
.section { padding: 16px 16px 8px; color: #646566; font-size: 14px; }
.photos { display: flex; gap: 8px; padding: 0 16px; flex-wrap: wrap; }
.pad { padding: 0 16px; }
.muted { color: #969799; font-size: 13px; }
.actions { display: flex; flex-direction: column; gap: 12px; padding: 24px 16px; }
</style>
