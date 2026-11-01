import { watch, ref, type Ref } from 'vue'
import type { PlanData, PlanAct } from './usePlanData'

/** GET /api/plan/templates 的一项 */
export interface PlanTemplateOption { id: string; name: string; nodes: unknown[] }

/** 总计划的按模板生成与发布（PlanEditor 拆分）：生成 / 发布都走确认框，再经 act 提交。 */
export function usePlanGeneration(options: { wo: Ref<string>; data: Ref<PlanData | null>; templates: Ref<PlanTemplateOption[]>; act: PlanAct }) {
  const { wo, data, templates, act } = options
  const templateId = ref<string | undefined>()
  watch(templates, (list) => (templateId.value ??= list[0]?.id), { immediate: true })
  function generate() {
    if (!templateId.value) return message.warning('请选择模板')
    const run = () => act(() => clientRequest('/api/plan/generate', { method: 'POST', body: { workOrderNumber: wo.value, templateId: templateId.value as string } }), (r) => `已生成 ${r.created} 个节点`)
    if (!data.value?.nodes.length) return run()
    Modal.confirm({ title: '按模板重新生成？', content: '现有节点会被替换，挂在上面的部门记录变成未挂', onOk: run })
  }

  function publish() {
    Modal.confirm({
      title: '发布总计划？',
      content: '发布后当前计划日记为基线，各责任部门负责人在“部门计划”里接收本部门的节点、分解任务；之后改日期、加删节点都要写原因。已发布工单新建部门记录必须选所属节点。',
      onOk: () =>
        act(
          () => clientRequest('/api/plan/publish', { method: 'POST', body: { workOrderNumber: wo.value } }),
          (r) => `已发布，发出 ${r.todos} 条接收待办${r.deptsWithoutHead.length ? `（${r.deptsWithoutHead.join('、')}没有负责人，没人收到）` : ''}`,
        ),
    })
  }

  return { templateId, generate, publish }
}
