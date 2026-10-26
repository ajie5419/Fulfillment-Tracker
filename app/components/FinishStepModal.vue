<script setup lang="ts">
/**
 * 电脑端完工弹窗（与手机"加工中"页同一接口）：默认剩余全部；
 * 数量不够时选"剩下的还在做"（部分完工，工序继续）或"报废了"（工序完成，自动转异常给生产经理安排补料）。
 */
const props = defineProps<{ step: { id: string; title: string; quantity: number; doneQty: number } | null }>()
const emit = defineEmits<{ close: []; done: [] }>()

const qty = ref(0)
const rest = ref<'CONTINUE' | 'SCRAP'>('CONTINUE')
const note = ref('')
const saving = ref(false)
const remaining = computed(() => (props.step ? Math.max(props.step.quantity - props.step.doneQty, 0) : 0))
const short = computed(() => remaining.value - (qty.value ?? 0))

watch(
  () => props.step,
  (s) => {
    if (!s) return
    qty.value = remaining.value
    rest.value = 'CONTINUE'
    note.value = ''
  },
  { immediate: true },
)

async function submit() {
  if (!props.step) return
  if (short.value > 0 && rest.value === 'CONTINUE' && !qty.value) return message.warning('部分完工至少 1 件')
  saving.value = true
  try {
    const body = short.value > 0 ? { source: 'PC', qty: qty.value, rest: rest.value, note: rest.value === 'SCRAP' ? note.value || null : null } : { source: 'PC' }
    const res = await $fetch(`/api/steps/${props.step.id}/finish`, { method: 'POST', body })
    message.success(short.value <= 0 ? '已完工' : rest.value === 'CONTINUE' ? `已报完工 ${qty.value} 件` : `已完工，报废已转异常 ${res.issueNo ?? ''}`)
    emit('done')
  } catch (e) {
    message.error(apiError(e))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <a-modal :open="!!step" :title="`完工：${step?.title ?? ''}`" :confirm-loading="saving" :ok-text="short > 0 && rest === 'CONTINUE' ? '报部分完工' : '确认完工'" @ok="submit" @cancel="emit('close')">
    <a-form layout="vertical">
      <a-form-item :label="`本次完成数量（共 ${step?.quantity ?? 0} 件${step?.doneQty ? `，已完成 ${step.doneQty} 件` : ''}）`">
        <a-input-number v-model:value="qty" :min="0" :max="remaining" :precision="0" addon-after="件" />
      </a-form-item>
      <template v-if="short > 0">
        <a-form-item :label="`还差 ${short} 件，剩下的`">
          <a-radio-group v-model:value="rest">
            <a-radio value="CONTINUE">还在做（含返修）</a-radio>
            <a-radio value="SCRAP">报废了</a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item v-if="rest === 'SCRAP'" label="报废原因">
          <a-input v-model:value="note" :maxlength="200" placeholder="可空" />
        </a-form-item>
        <p class="muted">{{ rest === 'CONTINUE' ? '工序继续加工，下一道先收到待办；剩下的做完再点完工。' : '本工序完成，报废的数量自动转成"车间"异常，默认给生产部负责人安排补料重做。' }}</p>
      </template>
      <p v-else class="muted">完工后自动给下一道工序发待办。</p>
    </a-form>
  </a-modal>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
</style>
