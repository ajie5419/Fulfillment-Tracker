import { ref } from 'vue'
import type { PartDetail } from '#shared/flow-view'
import type { WorkbenchTodo } from './useWorkbenchFeed'

/**
 * 工作台待办的动作弹窗流（pages/index.vue 拆分）：登记发出 / 开工 / 完工 / 完成部门任务 / 转交。
 * 处理成功后统一调 afterTodo（刷新待办、提醒和菜单角标）。
 */
export function useWorkbenchTodoActions(options: { afterTodo: () => Promise<void> }) {
  const { afterTodo } = options

  const sending = ref<{ id: string; supplierId: string | null; title: string } | null>(null)
  function openSend(t: WorkbenchTodo) {
    if (t.step) sending.value = { id: t.step.id, supplierId: t.step.supplierId, title: `${t.step.partName} · ${t.step.processName}` }
  }

  function start(t: WorkbenchTodo) {
    if (!t.step) return
    Modal.confirm({
      title: `确认开工：${t.step.partName} · ${t.step.processName}？`,
      okText: '开工',
      async onOk() {
        try {
          await $fetch(`/api/steps/${t.step!.id}/start`, { method: 'POST', body: { source: 'PC' } })
          message.success('已开工')
          await afterTodo()
        } catch (e) {
          message.error(apiError(e))
        }
      },
    })
  }

  /** 直接完工（活已经干完才想起登记，生产管理重设计第一批）：同一个完工弹窗，可部分完工、报废 */
  const finishing = ref<{ id: string; title: string; quantity: number; doneQty: number } | null>(null)
  async function finish(t: WorkbenchTodo) {
    if (!t.step) return
    try {
      const p = await $fetch<PartDetail>(`/api/parts/${t.step.partId}`)
      const s = p.steps.find((x) => x.id === t.step!.id)
      finishing.value = { id: t.step.id, title: `${t.step.partName} · ${t.step.processName}`, quantity: p.quantity, doneQty: s?.returnedQty ?? 0 }
    } catch (e) {
      message.error(apiError(e))
    }
  }

  /** 完成部门任务（部门计划二次分解）：完成日记今天，关掉待办 */
  function finishPlanTask(t: WorkbenchTodo) {
    const task = t.planTask
    if (!task) return
    Modal.confirm({
      title: `完成"${task.name}"？`,
      content: `总计划节点"${task.nodeName}"下的任务，完成日记为今天。`,
      onOk: async () => {
        try {
          await $fetch(`/api/plan/tasks/${task.id}/complete`, { method: 'POST', body: {} })
          message.success('已完成')
          await afterTodo()
        } catch (e) {
          message.error(apiError(e))
        }
      },
    })
  }

  /** 发放签收、确认变更影响：打开发放单详情抽屉处理 */
  const releaseId = ref<string | null>(null)

  const transferring = ref<WorkbenchTodo | null>(null)
  const transferTo = ref<string | undefined>()
  async function transfer() {
    if (!transferring.value || !transferTo.value) return message.warning('请选择转交对象')
    try {
      await $fetch(`/api/todos/${transferring.value.id}/transfer`, { method: 'POST', body: { toUserId: transferTo.value } })
      message.success('已转交')
      transferring.value = null
      transferTo.value = undefined
      await afterTodo()
    } catch (e) {
      message.error(apiError(e))
    }
  }

  return { sending, openSend, start, finishing, finish, finishPlanTask, releaseId, transferring, transferTo, transfer }
}
