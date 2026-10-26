<script setup lang="ts">
/**
 * 工序操作的弹窗集中在这里（生产管理重设计第一批）：生产调度、外协页、工作台共用。
 *   开工（确认后开工）、完工（FinishStepModal：部分完工 / 报废）、发出（SendStepModal）、登记返厂（QMS 漏报时补登）、指定负责人。
 * 页面放一个 <StepActionHost ref="host" @done="refresh" />，按钮里调 host.run('start', row)。接口和权限与原来一样（后端最终判断）。
 */
import type { ActionRow, PrimaryAction } from '#shared/production'
const emit = defineEmits<{ done: [] }>()
const { data: master } = await useMaster()

const finishing = ref<{ id: string; title: string; quantity: number; doneQty: number } | null>(null)
const sending = ref<{ id: string; supplierId: string | null; title: string } | null>(null)
const returning = reactive({ open: false, row: null as ActionRow | null, qty: 1 })
const assigning = reactive({ open: false, row: null as ActionRow | null, ownerId: undefined as string | undefined })
const userOptions = computed(() => master.value.users.map((u) => ({ value: u.id, label: `${u.name}${u.department ? `（${u.department}）` : ''}` })))
const title = (r: ActionRow) => `${r.partName} · ${r.processName}`

async function done(ok?: string) {
  if (ok) message.success(ok)
  emit('done')
  await refreshNuxtData('todos')
}

function run(action: Exclude<PrimaryAction, null>, r: ActionRow) {
  if (action === 'start') {
    Modal.confirm({
      title: `确认开工：${title(r)}？`,
      okText: '开工',
      onOk: async () => {
        try {
          await $fetch(`/api/steps/${r.stepId}/start`, { method: 'POST', body: { source: 'PC' } })
          await done('已开工')
        } catch (e) {
          message.error(apiError(e))
        }
      },
    })
  } else if (action === 'finish') finishing.value = { id: r.stepId, title: title(r), quantity: r.quantity, doneQty: r.doneQty }
  else if (action === 'send') sending.value = { id: r.stepId, supplierId: r.supplierId, title: title(r) }
  else if (action === 'return') Object.assign(returning, { open: true, row: r, qty: Math.max(r.quantity - r.doneQty, 1) })
  else if (action === 'assign') Object.assign(assigning, { open: true, row: r, ownerId: r.ownerId ?? undefined })
}
defineExpose({ run })

async function doReturn() {
  if (!returning.row) return
  try {
    await $fetch(`/api/steps/${returning.row.stepId}/return`, { method: 'POST', body: { qty: returning.qty, source: 'PC' } })
    returning.open = false
    await done('已登记返厂')
  } catch (e) {
    message.error(apiError(e))
  }
}
async function doAssign() {
  if (!assigning.row || !assigning.ownerId) return message.warning('请选择负责人')
  try {
    await $fetch(`/api/steps/${assigning.row.stepId}`, { method: 'PATCH', body: { ownerId: assigning.ownerId } })
    assigning.open = false
    await done('已指定负责人')
  } catch (e) {
    message.error(apiError(e))
  }
}
</script>

<template>
  <FinishStepModal :step="finishing" @close="finishing = null" @done="finishing = null; done()" />
  <SendStepModal :step="sending" @close="sending = null" @done="sending = null; done()" />
  <a-modal :open="returning.open" :title="`登记返厂：${returning.row ? title(returning.row) : ''}`" ok-text="登记" @ok="doReturn" @cancel="returning.open = false">
    <p class="muted">返厂以 QMS 报检为准，自动记上；QMS 漏报检时在这里补登。全部返回后这道自动完成。</p>
    <a-input-number v-model:value="returning.qty" :min="1" :precision="0" addon-after="件" />
    <span v-if="returning.row" class="muted"> 已回 {{ returning.row.doneQty }}/{{ returning.row.quantity }}</span>
  </a-modal>
  <a-modal :open="assigning.open" :title="`指定负责人：${assigning.row ? title(assigning.row) : ''}`" ok-text="保存" @ok="doAssign" @cancel="assigning.open = false">
    <p class="muted">负责人收到开工 / 发出待办和逾期提醒；没有负责人时上一道完成后发不出待办。</p>
    <a-select v-model:value="assigning.ownerId" show-search option-filter-prop="label" placeholder="选择负责人" :options="userOptions" style="width: 100%" />
  </a-modal>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
</style>
