<script setup lang="ts">
const requestFetch = useRequestFetch()
/** 电脑端发出登记弹窗：选外协厂（默认工序链里计划的，或上次用的）+ 承诺返回日 + 随件发料（外协带料时写上发了什么，在途里能看到） */
const props = defineProps<{ step: { id: string; supplierId: string | null; title: string } | null }>()
const emit = defineEmits<{ close: []; done: [] }>()

const { data: master } = await useMaster()
const supplierId = ref<string | undefined>()
const promisedReturnDate = ref<string | undefined>()
const note = ref('')
const saving = ref(false)

watch(
  () => props.step,
  async (step) => {
    if (!step) return
    promisedReturnDate.value = dayAfter(7)
    note.value = ''
    supplierId.value = step.supplierId ?? undefined
    if (!supplierId.value) supplierId.value = (await requestFetch('/api/last-supplier')).supplierId ?? undefined
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
      body: { supplierId: supplierId.value, promisedReturnDate: promisedReturnDate.value, note: note.value || null, source: 'PC' },
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
        <UiDatePicker v-model:value="promisedReturnDate" style="width: 100%" />
      </a-form-item>
      <a-form-item label="随件发料" extra="外协厂需要我们供料时写上发了什么、多少，如：Q355 钢板 20mm × 2 张">
        <a-input v-model:value="note" :maxlength="200" placeholder="不供料就空着" />
      </a-form-item>
    </a-form>
  </a-modal>
</template>
