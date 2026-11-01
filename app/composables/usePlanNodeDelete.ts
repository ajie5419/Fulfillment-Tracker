import { ref, type Ref } from 'vue'
import type { PlanNodeRow } from '#shared/plan-view'
import type { PlanAct } from './usePlanData'

/** 删除节点（PlanEditor 拆分）：未发布直接确认；已发布要先填删除原因（记入调整记录）。 */
export function usePlanNodeDelete(options: { published: Ref<boolean>; act: PlanAct }) {
  const { published, act } = options
  const reasonOpen = ref(false)
  const reasonText = ref('')
  const reasonFor = ref<PlanNodeRow | null>(null)
  function askDelete(node: PlanNodeRow) {
    if (!published.value) {
      return Modal.confirm({
        title: `删除节点"${node.name}"？`,
        content: '挂在上面的部门记录变成未挂',
        okType: 'danger',
        onOk: () => act(() => clientRequest(`/api/plan/nodes/${node.id}`, { method: 'DELETE', body: {} }), '已删除'),
      })
    }
    reasonFor.value = node
    reasonText.value = ''
    reasonOpen.value = true
  }
  async function submitReason() {
    const n = reasonFor.value
    if (!n) return
    if (!reasonText.value.trim()) return message.warning('请写删除原因')
    const ok = await act(() => clientRequest(`/api/plan/nodes/${n.id}`, { method: 'DELETE', body: { reason: reasonText.value } }), '已删除')
    if (ok) reasonOpen.value = false
  }

  return { reasonOpen, reasonText, reasonFor, askDelete, submitReason }
}
