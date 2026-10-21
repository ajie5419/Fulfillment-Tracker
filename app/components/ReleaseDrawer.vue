<script setup lang="ts">
/** 发放单详情抽屉：内容、附件、每个接收人的签收状态；签收 / 拒收、确认变更影响、作废 */
const props = defineProps<{ id: string | null }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const detail = ref<ReleaseDetail | null>(null)
const loading = ref(false)
const loadError = ref('')

async function load() {
  if (!props.id) return
  loading.value = true
  loadError.value = ''
  try {
    detail.value = await fetchRelease(props.id)
  } catch (e) {
    detail.value = null
    loadError.value = apiError(e)
  } finally {
    loading.value = false
  }
}
watch(() => props.id, load, { immediate: true })

const busy = ref(false)
async function act(url: string, body: object, ok: string) {
  busy.value = true
  try {
    await releasePost(url, body)
    message.success(ok)
    await load()
    await refreshNuxtData(['todos', 'reminders'])
    emit('changed')
    return true
  } catch (e) {
    message.error(apiError(e))
    return false
  } finally {
    busy.value = false
  }
}

const sign = () => detail.value?.myReceipt && act(`/api/receipts/${detail.value.myReceipt.id}/sign`, {}, '已签收')

const rejecting = ref(false)
const reason = ref('')
async function reject() {
  if (!reason.value.trim()) return message.warning('请填写拒收原因')
  if (detail.value?.myReceipt && (await act(`/api/receipts/${detail.value.myReceipt.id}/reject`, { reason: reason.value.trim() }, '已拒收，已通知发放人'))) {
    rejecting.value = false
    reason.value = ''
  }
}

const confirming = ref(false)
const note = ref('')
async function confirmChange() {
  if (detail.value && (await act(`/api/releases/${detail.value.id}/confirm-change`, { note: note.value.trim() || null }, '已确认变更影响，"等变更"已解除'))) {
    confirming.value = false
    note.value = ''
  }
}

function voidIt() {
  const d = detail.value
  if (!d) return
  Modal.confirm({
    title: `作废 ${d.releaseNo}？`,
    content: '未签收的签收记录和待办一并作废，"等变更"解除。已签收的记录保留。',
    okText: '作废',
    okType: 'danger',
    onOk: () => act(`/api/releases/${d.id}/void`, {}, '已作废'),
  })
}

const receiptColumns = [
  { title: '接收人', key: 'user' },
  { title: '状态', key: 'status', width: 90 },
  { title: '时间', key: 'time', width: 170 },
  { title: '拒收原因', dataIndex: 'reason' },
]
</script>

<template>
  <a-drawer :open="!!id" width="720" :title="detail ? `${detail.typeText} ${detail.releaseNo}` : '发放单'" @close="emit('close')">
    <a-spin :spinning="loading">
      <a-result v-if="loadError" status="warning" :title="loadError" />
      <template v-else-if="detail">
        <a-alert v-if="detail.status === 'VOID'" type="warning" show-icon message="这张发放单已作废" class="block" />
        <!-- 我是接收人且未签收：最显眼的位置 -->
        <a-alert v-if="detail.permissions.sign" type="info" show-icon class="block" message="这份发放单发给了你，请核对收到的图纸/文件后签收">
          <template #action>
            <a-space direction="vertical">
              <a-button type="primary" size="small" :loading="busy" @click="sign">签收</a-button>
              <a-button size="small" danger :disabled="busy" @click="rejecting = true">拒收</a-button>
            </a-space>
          </template>
        </a-alert>
        <a-alert
          v-else-if="detail.myReceipt && detail.myReceipt.status !== 'PENDING'"
          :type="detail.myReceipt.status === 'SIGNED' ? 'success' : 'warning'"
          show-icon
          class="block"
          :message="`你已${RECEIPT_STATUS_TEXT[detail.myReceipt.status].replace('已', '')}（${timeText(detail.myReceipt.actedAt)}）${detail.myReceipt.reason ? `：${detail.myReceipt.reason}` : ''}`"
        />

        <a-descriptions :column="2" bordered size="small" class="block">
          <a-descriptions-item label="类型"><a-tag :color="RELEASE_TYPE_COLOR[detail.type]">{{ detail.typeText }}</a-tag></a-descriptions-item>
          <a-descriptions-item label="版本号">{{ detail.version ?? '—' }}</a-descriptions-item>
          <a-descriptions-item label="工单" :span="2"><WoLink :no="detail.workOrderNumber" /><span class="muted">　{{ detail.projectName ?? detail.customerName }}</span></a-descriptions-item>
          <a-descriptions-item label="关联工件" :span="2">
            <span v-if="!detail.parts.length && !detail.missingParts" class="muted">未关联</span>
            <a-tag v-for="p in detail.parts" :key="p.id">{{ p.name }}<template v-if="p.drawingNo">（{{ p.drawingNo }}）</template></a-tag>
            <span v-if="detail.missingParts" class="muted">另有 {{ detail.missingParts }} 个工件已删除</span>
          </a-descriptions-item>
          <a-descriptions-item label="说明" :span="2"><div class="pre">{{ detail.description }}</div></a-descriptions-item>
          <a-descriptions-item label="附件" :span="2">
            <span v-if="!detail.attachments.length" class="muted">无（纸质下发）</span>
            <a-space wrap>
              <a v-for="(a, i) in detail.attachments" :key="a.id" :href="a.url" target="_blank" rel="noopener">
                <img v-if="isImage(a.mime)" :src="a.url" class="thumb" :alt="`附件 ${i + 1}`" />
                <span v-else>📄 PDF 附件 {{ i + 1 }}（{{ sizeText(a.size) }}）</span>
              </a>
            </a-space>
          </a-descriptions-item>
          <a-descriptions-item label="发放人">{{ detail.issuerName }}</a-descriptions-item>
          <a-descriptions-item label="发放时间">{{ timeText(detail.createdAt) }}</a-descriptions-item>
        </a-descriptions>

        <template v-if="detail.change">
          <h4>设计变更影响</h4>
          <a-alert
            v-if="detail.change.confirmedAt"
            type="success"
            show-icon
            class="block"
            :message="`已确认（${timeText(detail.change.confirmedAt)}${detail.change.confirmedByName ? `，${detail.change.confirmedByName}` : ''}）${detail.change.confirmNote ? `：${detail.change.confirmNote}` : ''}`"
          />
          <a-alert v-else-if="detail.change.needsConfirm" type="warning" show-icon class="block">
            <template #message>
              <span v-if="detail.change.confirmers.length">待确认变更影响：{{ detail.change.confirmers.map((c) => c.userName).join('、') }}（任一人确认即可）</span>
              <span v-else>没有在加工的工序：接收人全部签收后自动解除"等变更"，也可由发放人直接确认</span>
              <span v-if="detail.change.heldSteps">；{{ detail.change.heldSteps }} 道未开工工序"等变更"中</span>
            </template>
            <template v-if="detail.permissions.confirmChange" #action>
              <a-button size="small" type="primary" :disabled="busy" @click="confirming = true">确认变更影响</a-button>
            </template>
          </a-alert>
          <div v-else class="muted block">关联工件没有在加工或未开工的工序，无需确认。</div>
        </template>

        <template v-if="detail.parts.some((p) => p.steps.length)">
          <h4>关联工件的工序</h4>
          <div v-for="p in detail.parts" :key="p.id" class="part-steps">
            <b>{{ p.name }}</b>：
            <span v-if="!p.steps.length" class="muted">没有工序</span>
            <span v-for="s in p.steps" :key="s.id" class="step">
              {{ s.seq }}. {{ s.processName }}<template v-if="s.supplierName">（{{ s.supplierName }}）</template>
              <a-tag :color="s.status === 'DONE' ? 'success' : s.status === 'PENDING' ? 'default' : 'processing'">{{ s.statusText }}</a-tag>
              <a-tag v-if="s.held" color="purple">等变更</a-tag>
              <a-tag v-else-if="s.heldByOther" color="purple">等变更（其他变更单）</a-tag>
            </span>
          </div>
        </template>

        <h4>签收情况（{{ detail.progressText }}：已签 {{ detail.counts.SIGNED }} / 共 {{ detail.receipts.length }}<template v-if="detail.counts.REJECTED">，拒收 {{ detail.counts.REJECTED }}</template>）</h4>
        <a-table :columns="receiptColumns" :data-source="detail.receipts" row-key="id" size="small" :pagination="false">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'user'">{{ record.userName }}<span class="muted">　{{ record.department ?? '' }}</span></template>
            <template v-else-if="column.key === 'status'">
              <a-tag :color="RECEIPT_STATUS_COLOR[record.status as ReceiptStatusKey]">{{ record.statusText }}</a-tag>
            </template>
            <template v-else-if="column.key === 'time'">{{ timeText(record.actedAt) || '—' }}</template>
          </template>
        </a-table>

        <div v-if="detail.permissions.void" class="footer">
          <a-button danger :disabled="busy" @click="voidIt">作废</a-button>
          <span class="muted">　发错了可以作废后重新发放</span>
        </div>
      </template>
    </a-spin>

    <a-modal :open="rejecting" title="拒收" ok-text="拒收" :ok-button-props="{ danger: true }" :confirm-loading="busy" @ok="reject" @cancel="rejecting = false">
      <a-textarea v-model:value="reason" :rows="3" :maxlength="500" show-count placeholder="写明原因，如：版本不对，现场是 A 版" />
    </a-modal>
    <a-modal :open="confirming" title="确认变更影响" ok-text="确认" :confirm-loading="busy" @ok="confirmChange" @cancel="confirming = false">
      <p class="muted">确认已评估在加工/在外协工序的影响（是否返工、是否通知外协厂）。确认后解除未开工工序的"等变更"，恢复预警计时。</p>
      <a-textarea v-model:value="note" :rows="3" :maxlength="500" show-count placeholder="处理意见，可空，如：已通知机加厂按新图扩孔" />
    </a-modal>
  </a-drawer>
</template>

<style scoped>
.block { margin-bottom: 16px; }
.muted { color: var(--ft-text-2); font-size: 12px; }
.pre { white-space: pre-wrap; }
.thumb { width: 96px; height: 96px; object-fit: cover; border-radius: 4px; border: 1px solid var(--ft-border); }
.part-steps { margin-bottom: 8px; }
.step { margin-right: 12px; white-space: nowrap; }
.footer { margin-top: 24px; }
h4 { margin: 16px 0 8px; }
</style>
