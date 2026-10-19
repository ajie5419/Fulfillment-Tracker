<script setup lang="ts">
/**
 * 手机到货确认页（R10，沿用发放签收的"看内容 → 签收"）：看物料、需求日、承诺日、付款情况，点"确认到货"。
 * 晚于需求日或承诺日时可以顺手选延误原因（不清楚可不填，采购稍后补）；确认错了可以撤销。
 * 确认 / 撤销到货：采购部、该工单项目经理、管理员（权限方案 R13），其他人只能看。
 */
definePageMeta({ layout: 'mobile' })
const { data: me } = await useMe()
const route = useRoute()
const id = computed(() => (route.query.id as string) || '')
const line = ref<PurchaseRow | null>(null)
const loadError = ref('')
const loading = ref(false)

async function load() {
  if (!id.value) return
  loading.value = true
  try {
    line.value = await fetchPurchase(id.value)
    loadError.value = ''
  } catch (e) {
    loadError.value = apiError(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(id, load)

const today = dayAfter(0)
const confirming = ref(false)
const form = reactive({ arrivedDate: today, delayReason: '' as string, delayNote: '' })
const late = computed(() => {
  const l = line.value
  if (!l) return false
  return form.arrivedDate > dayText(l.needDate) || (!!l.promisedDate && form.arrivedDate > dayText(l.promisedDate))
})
function openConfirm() {
  const l = line.value
  if (!l) return
  Object.assign(form, { arrivedDate: today, delayReason: l.delayReason ?? (l.blockedByPayment ? 'PAYMENT' : ''), delayNote: l.delayNote ?? '' })
  confirming.value = true
}

const busy = ref(false)
async function confirm() {
  const l = line.value
  if (!l) return
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.arrivedDate) || form.arrivedDate > today) {
    showToast('到货日期不能晚于今天')
    return
  }
  busy.value = true
  try {
    const r = await purchaseSend<{ readySent: boolean }>(`/api/purchases/${l.id}/arrive`, 'POST', {
      arrivedDate: form.arrivedDate,
      delayReason: late.value ? form.delayReason || null : undefined,
      delayNote: late.value && form.delayReason ? form.delayNote.trim() || null : undefined,
      source: 'MOBILE',
    })
    confirming.value = false
    showSuccessToast(r.readySent ? '已确认到货，工件物料已齐' : '已确认到货')
    await load()
    await refreshNuxtData(['todos', 'reminders'])
  } catch (e) {
    showFailToast(apiError(e))
  } finally {
    busy.value = false
  }
}

async function undo() {
  const l = line.value
  if (!l) return
  try {
    await showConfirmDialog({ title: '撤销到货', message: l.arrivalSource === 'QMS_INSPECTION' ? '这一项是 QMS 进货检验自动确认的，撤销后只能手工确认' : '回到未到货' })
  } catch {
    return
  }
  busy.value = true
  try {
    await purchaseSend(`/api/purchases/${l.id}/undo-arrival`, 'POST')
    showSuccessToast('已撤销')
    await load()
    await refreshNuxtData(['todos', 'reminders']) // 撤销会作废没处理的"可以开工"待办
  } catch (e) {
    showFailToast(apiError(e))
  } finally {
    busy.value = false
  }
}
const sourceText = { MOBILE: '手机确认', PC: '电脑确认', QMS_INSPECTION: 'QMS 进货检验自动确认' } as const
</script>

<template>
  <div>
    <van-nav-bar :title="line ? line.materialName : '到货确认'" left-arrow @click-left="navigateTo('/m/arrivals')" />
    <van-loading v-if="loading && !line" class="m-center" />
    <van-empty v-else-if="loadError" :description="loadError" image="error" />
    <template v-else-if="line">
      <div v-if="line.status === 'CANCELLED'" class="m-hint none"><UiStatusIcon kind="ring" tone="none" :size="14" />这一项已取消，不再跟踪</div>
      <div v-else-if="line.status === 'ARRIVED'" class="m-hint done">
        <UiStatusIcon kind="check" :size="14" />已到货 {{ dayText(line.arrivedDate) }}（{{ line.arrivalSource ? sourceText[line.arrivalSource] : '' }}{{ line.arrivedByName && line.arrivalSource !== 'QMS_INSPECTION' ? ` · ${line.arrivedByName}` : '' }}）
      </div>
      <div v-else-if="line.blockedByPayment" class="m-hint risk"><UiStatusIcon kind="warn" :size="14" />有卡交期的付款还没付</div>
      <div class="summary">
        <div class="m-row">
          <van-tag :type="PURCHASE_PROGRESS_TYPE[line.progressText] ?? 'default'">{{ line.progressText }}</van-tag>
          <span v-if="line.lateDays" class="late m-text-late">晚 {{ line.lateDays }} 天</span>
        </div>
        <div class="m-title summary-name">{{ line.materialName }}</div>
        <div class="m-meta"><span>{{ line.workOrderNumber }}</span><span>需求 {{ dayText(line.needDate) }}</span><span>{{ line.promisedDate ? `承诺 ${dayText(line.promisedDate)}` : '未承诺' }}</span></div>
      </div>
      <van-cell-group inset class="group" title="明细">
        <van-cell title="物料" :value="line.materialName" :label="line.spec ?? ''" />
        <van-cell title="数量" :value="qtyText(line)" />
        <van-cell title="供应商" :value="line.supplierName ?? '—'" />
        <van-cell title="工单" :value="line.workOrderNumber" :label="line.projectName ?? line.customerName ?? ''" />
        <van-cell v-if="line.partName" title="用于工件" :value="line.partName" />
        <van-cell title="需求日" :value="dayText(line.needDate)" />
        <van-cell title="承诺到货日" :value="line.promisedDate ? dayText(line.promisedDate) : '未承诺'" />
        <van-cell title="进度">
          <template #value><van-tag :type="PURCHASE_PROGRESS_TYPE[line.progressText] ?? 'default'">{{ line.progressText }}</van-tag><span v-if="line.lateDays" class="muted"> 晚 {{ line.lateDays }} 天</span></template>
        </van-cell>
        <van-cell v-if="line.delayReason" title="延误原因" :value="line.delayReasonText ?? ''" :label="line.delayNote ?? ''" />
        <van-cell title="采购负责人" :value="line.ownerText" />
        <van-cell v-for="p in line.payments" :key="p.id" title="付款申请" :value="`${p.statusText} ${moneyWithUnit(p.amount)}`" :label="p.blocksDelivery ? '卡交期' : ''" />
      </van-cell-group>

      <div class="m-actions">
        <template v-if="canDo(me, 'purchase', { workOrderNumber: line.workOrderNumber })">
          <van-button v-if="line.status === 'OPEN'" type="primary" block round :loading="busy" @click="openConfirm">确认到货</van-button>
          <van-button v-if="line.status === 'ARRIVED'" plain block round :disabled="busy" @click="undo">撤销到货</van-button>
        </template>
        <p v-else class="readonly-tip">确认到货由采购部或该工单项目经理操作</p>
      </div>
    </template>

    <van-dialog :show="confirming" title="确认到货" show-cancel-button :before-close="() => false" @confirm="confirm" @cancel="confirming = false">
      <van-field v-model="form.arrivedDate" label="到货日期" type="date" />
      <template v-if="late">
        <div class="pad muted">晚于需求日或承诺日，请选延误原因（不清楚可不选）</div>
        <van-radio-group v-model="form.delayReason" class="pad reasons">
          <van-radio v-for="o in DELAY_REASON_OPTIONS" :key="o.value" :name="o.value">{{ o.label }}</van-radio>
        </van-radio-group>
        <van-field v-if="form.delayReason" v-model="form.delayNote" label="说明" maxlength="500" placeholder="可空" />
      </template>
    </van-dialog>
  </div>
</template>

<style scoped>
.summary { margin: 12px 12px 0; padding: 14px 16px; background: #fff; border-radius: var(--ft-card-radius); box-shadow: var(--ft-card-shadow); }
.summary-name { margin-top: 6px; font-size: 17px; }
.late { font-size: 12px; font-weight: 600; }
.pad { padding: 8px 16px; }
.readonly-tip { color: var(--ft-text-3); font-size: 13px; text-align: center; margin: 8px 0; }
.muted { color: var(--ft-text-3); font-size: 13px; }
.reasons { display: flex; flex-wrap: wrap; gap: 12px; }
</style>
