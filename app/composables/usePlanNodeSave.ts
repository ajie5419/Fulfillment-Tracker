import { h, type Ref } from 'vue'
import { isPlanAdjustmentReasonMissing } from '#shared/plan-validation'
import type { PlanNodeRow } from '#shared/plan-view'
import type { PlanNodeForm } from './usePlanNodeForm'
import type { PlanAct } from './usePlanData'
import type { SchedulePreview } from '../../server/services/plan/schedule-preview'

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
      requiresProcess: form.requiresProcess,
      phase: form.phase || null,
      startDate: form.startDate ? form.startDate.format('YYYY-MM-DD') : null,
      planDate: form.planDate.format('YYYY-MM-DD'),
      seq: form.seq ?? null,
      parentId: form.parentId ?? null,
      preds: form.depMode === 'custom' ? form.preds : null,
      note: form.note || null,
      reason: form.reason || null,
    }
    const editingId = editing.value?.id
    const linkedDates = !!editing.value && (body.planDate !== editing.value.planDate || body.startDate !== editing.value.startDate)
    const save = async (previewToken?: string) => {
      const ok = await act(
        async () => (editingId ? await clientRequest(`/api/plan/nodes/${editingId}`, { method: 'PATCH', body: { ...body, ...(linkedDates ? { linkedDates, previewToken } : {}) } }) : await clientRequest('/api/plan/nodes', { method: 'POST', body: { workOrderNumber: wo.value, ...body } })),
        (r) => ((r && typeof r === 'object' && 'reconfirm' in r && r.reconfirm) || (!editing.value && published.value) ? '已保存，已重新请责任部门接收' : '已保存'),
      )
      if (ok) editOpen.value = false
    }
    if (!linkedDates || !editingId) return save()
    try {
      const result = await clientRequest(`/api/plan/nodes/${editingId}`, { method: 'PATCH', body: { ...body, linkedDates: true, preview: true } })
      const preview: SchedulePreview | undefined = result.preview
      if (!preview) throw new Error('未能获取联动预览，请重试')
      Modal.confirm({
        title: `确认调整 ${preview.changes.length} 个节点的日期`,
        width: 720,
        okText: '确认保存',
        cancelText: '返回修改',
        content: h('div', [
          h('p', '后续节点最早从前置完成后的下一个工厂工作日开始，跳过配置的停工日，保留自然日工期，先消化空档。前置日期提前时，后续计划保持不动；未填开始日按单日节点处理。'),
          h('div', { style: { maxHeight: '45vh', overflow: 'auto' } }, preview.changes.map((c) => h('p', { key: c.id }, [
            h('strong', c.name), h('br'),
            `原：${c.oldStart ?? '未设开始日'} ～ ${c.oldFinish}`, h('br'),
            `新：${c.start ?? '未设开始日'} ～ ${c.finish}`,
          ]))),
          ...(preview.skipped.length ? [h('p', `已完成，保持原日期：${preview.skipped.join('、')}`)] : []),
          ...(published.value ? [h('p', '保存后记录调整原因，并重新请受影响的责任部门接收；部门任务日期由部门安排。')] : []),
        ]),
        onOk: () => save(preview.token),
      })
    } catch (error) { message.error(apiError(error)) }
  }

  return { saveNode }
}
