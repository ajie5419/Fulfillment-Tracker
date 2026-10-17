<script setup lang="ts">
/** 电脑端发出登记弹窗：选外协厂（默认工序链里计划的，或上次用的）+ 承诺返回日 */
const props = defineProps<{ step: { id: string; supplierId: string | null; title: string } | null }>()
const emit = defineEmits<{ close: []; done: [] }>()

const { data: master } = await useMaster()
const supplierId = ref<string | undefined>()
const promisedReturnDate = ref<string | undefined>()
const saving = ref(false)

watch(
  () => props.step,
  async (step) => {
    if (!step) return
    promisedReturnDate.value = dayAfter(7)
    supplierId.value = step.supplierId ?? undefined
    if (!supplierId.value) supplierId.value = (await $fetch('/api/last-supplier')).supplierId ?? undefined
  },
  { immediate: true },
)

async function submit() {
  if (!props.step) return
  if (!supplierId.value || !promisedReturnDate.value) return message.warning('请选择外协厂和承诺返回日')
  saving.value = true
  try {
    await $fetch(`/api/steps/${props.step.id}/send`, {
      method: 'POST',
      body: { supplierId: supplierId.value, promisedReturnDate: promisedReturnDate.value, source: 'PC' },
    })
    message.success('已登记发出')
    emit('done')
  } catch (e) {
    message.error(apiError(e))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <a-modal :open="!!step" :title="`发出登记：${step?.title ?? ''}`" :confirm-loading="saving" ok-text="提交" @ok="submit" @cancel="emit('close')">
    <a-form layout="vertical">
      <a-form-item label="外协厂" required>
        <a-select v-model:value="supplierId" show-search option-filter-prop="label" :options="master.suppliers.map((s) => ({ value: s.id, label: s.label }))" />
      </a-form-item>
      <a-form-item label="承诺返回日" required>
        <a-date-picker v-model:value="promisedReturnDate" value-format="YYYY-MM-DD" style="width: 100%" />
      </a-form-item>
    </a-form>
  </a-modal>
</template>
