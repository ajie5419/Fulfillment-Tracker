<script setup lang="ts">
import dayjs, { type Dayjs } from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'

/** 字符串日期专用：在 Ant 4.2.6 关闭面板、恢复输入文本之前提交手打值。 */
dayjs.extend(customParseFormat)
const props = defineProps<{ value?: string | null; disabledDate?: (date: Dayjs) => boolean }>()
const emit = defineEmits<{ 'update:value': [value: string | null]; change: [value: string | null, text: string]; openChange: [open: boolean] }>()
const picker = ref<{ $el: HTMLElement; focus: () => void; blur: () => void } | null>(null)
const open = ref(false)
// Ant 的类型遗漏 null；运行时空日期须保持受控，避免内部草稿成为已提交值。
const pickerValue = computed(() => (props.value ?? null) as string | undefined)
let pickerChanged = false
let cancelling = false
let rejecting = false

function inputDate() {
  const text = picker.value?.$el.querySelector('input')?.value ?? ''
  const date = dayjs(text, 'YYYY-MM-DD', true)
  return date.isValid() && !props.disabledDate?.(date) ? text : null
}
function change(value: string | Dayjs | null, text: string) {
  if (rejecting) return
  pickerChanged = true
  const day = typeof value === 'string' ? value : value?.format('YYYY-MM-DD') ?? null
  emit('update:value', day)
  emit('change', day, text)
}
function openChange(next: boolean) {
  open.value = next
  if (!next && !pickerChanged && !cancelling) {
    const text = inputDate()
    if (text) {
      if (text !== props.value) change(text, text)
    } else {
      // 阻止同一次 blur 把上一个合法的输入片段提交；关闭后由 Ant 恢复原值。
      rejecting = true
      nextTick(() => { rejecting = false })
    }
  }
  pickerChanged = false
  cancelling = false
  emit('openChange', next)
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') cancelling = true
  if (event.key === 'Enter' && !inputDate()) {
    event.preventDefault()
    openChange(false)
  }
}
defineExpose({ focus: () => picker.value?.focus(), blur: () => picker.value?.blur() })
</script>

<template>
  <a-date-picker ref="picker" :value="pickerValue" :open="open" :disabled-date="disabledDate" format="YYYY-MM-DD" value-format="YYYY-MM-DD" @change="change" @open-change="openChange" @keydown="keydown" />
</template>
