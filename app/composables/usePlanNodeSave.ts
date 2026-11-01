import type { Ref } from 'vue'
import { isPlanAdjustmentReasonMissing } from '#shared/plan-validation'
import type { PlanNodeRow } from '#shared/plan-view'
import type { PlanNodeForm } from './usePlanNodeForm'
import type { PlanAct } from './usePlanData'

/**
 * 保存新增 / 编辑节点（PlanEditor 拆分）：校验 → 新增 POST / 编辑 PATCH → 成功关弹窗。
 * startLate / needReason 由 PlanEditor 基于表单状态派生后传入（它们是已有单测钉住的纯 computed）。
 */
export function usePlanNodeSave(options: {
  wo: Ref<string>
  published: Ref<boolean>
  editing: Ref<PlanNodeRow | null>
  form: PlanNodeForm
  editOpen: Ref<boolean>
  startLate: Ref<boolean>
  needReason: Ref<boolean>
  act: PlanAct
}) {
  const { wo, published, editing, form, editOpen, startLate, needReason, act } = options
  async function saveNode() {
    if (!form.name.trim()) return message.warning('请填写节点名称')
    if (!form.planDate) return message.warning('请选择计划日期')
    if (startLate.value) return message.warning('计划开始日不能晚于计划完成日')
    if (isPlanAdjustmentReasonMissing(needReason.value, form.reason)) return message.warning('总计划已发布，请写调整原因')
    const body = {
      name: form.name,
      dept: form.dept,
      phase: form.phase || null,
      startDate: form.startDate ? form.startDate.format('YYYY-MM-DD') : null,
      planDate: form.planDate.format('YYYY-MM-DD'),
      seq: form.seq ?? null,
      parentId: form.parentId ?? null,
      preds: form.depMode === 'custom' ? form.preds : null,
      note: form.note || null,
      reason: form.reason || null,
    }
    const ok = await act(
      () => (editing.value ? clientRequest(`/api/plan/nodes/${editing.value.id}`, { method: 'PATCH', body }) : clientRequest('/api/plan/nodes', { method: 'POST', body: { workOrderNumber: wo.value, ...body } })),
      (r) => (('reconfirm' in r && r.reconfirm) || (!editing.value && published.value) ? '已保存，已重新请责任部门接收' : '已保存'),
    )
    if (ok) editOpen.value = false
  }

  return { saveNode }
}
