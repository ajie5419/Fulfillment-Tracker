import dayjs, { type Dayjs } from 'dayjs'
import { computed, reactive, ref, type Ref } from 'vue'
import type { BusinessDeptCode } from '#shared/business-depts'
import type { PlanNodeRow } from '#shared/plan-view'
import type { PlanData } from './usePlanData'

/** 新增 / 编辑节点弹窗的表单 */
export interface PlanNodeForm {
  name: string
  dept: BusinessDeptCode
  phase: string
  startDate: Dayjs | undefined
  planDate: Dayjs | undefined
  seq: number | undefined
  /** 上级节点（子节点）；空 = 一级节点 */
  parentId: string | undefined
  /** default = 默认（一级节点等上一个一级节点，子节点没有前置）；custom = 自己选（可以不选 = 没有前置） */
  depMode: 'default' | 'custom'
  preds: string[]
  note: string
  reason: string
}

/** 新增 / 编辑节点的表单状态与下拉选项（PlanEditor 拆分）；保存见 usePlanNodeSave。 */
export function usePlanNodeForm(data: Ref<PlanData | null>) {
  const editOpen = ref(false)
  const editing = ref<PlanNodeRow | null>(null)
  const form = reactive<PlanNodeForm>({ name: '', dept: 'PROJECT', phase: '', startDate: undefined, planDate: undefined, seq: undefined, parentId: undefined, depMode: 'default', preds: [], note: '', reason: '' })
  /** 编辑节点；新增时 under = 加在哪个节点下面（子节点，责任部门、计划完成日先按上级填） */
  function openEdit(n: PlanNodeRow | null, under: PlanNodeRow | null = null) {
    editing.value = n
    const last = data.value?.nodes.at(-1)
    Object.assign(form, {
      name: n?.name ?? '',
      dept: n?.dept ?? under?.dept ?? 'PROJECT',
      phase: n?.phase ?? (n ? '' : (last?.phase ?? '')),
      startDate: n?.startDate ? dayjs(n.startDate) : undefined,
      planDate: n ? dayjs(n.planDate) : under ? dayjs(under.planDate) : undefined,
      seq: n?.seq ?? undefined,
      parentId: n?.parentId ?? under?.id ?? undefined,
      depMode: n?.customDeps ? 'custom' : 'default',
      preds: n?.customDeps ? n.preds.map((p) => p.id) : [],
      note: n?.note ?? '',
      reason: '',
    })
    editOpen.value = true
  }
  /** 前置节点下拉：同一份计划的其他节点（不含自己的上级：上级要等子节点做完） */
  const predOptions = computed(() =>
    (data.value?.nodes ?? []).filter((x) => x.id !== editing.value?.id && x.id !== form.parentId).map((x) => ({ value: x.id, label: `${x.code} ${x.name}` })),
  )
  const phaseOptions = computed(() => (data.value?.phases ?? []).map((v) => ({ value: v })))
  /** 上级节点下拉：一级节点（不含自己）；自己下面有子节点时不能再挂到别人下面 */
  const parentOptions = computed(() =>
    (data.value?.nodes ?? []).filter((x) => !x.parentId && x.id !== editing.value?.id).map((x) => ({ value: x.id, label: `${x.code} ${x.name}` })),
  )
  const formParent = computed(() => (data.value?.nodes ?? []).find((x) => x.id === form.parentId) ?? null)
  /** 默认前置：一级节点 = 上一个一级节点；子节点 = 没有前置（和兄弟子节点同时开始） */
  const defaultPredText = computed(() => {
    if (formParent.value) return '没有前置（可以和同一上级下的其他子节点同时开始）'
    const list = (data.value?.nodes ?? []).filter((x) => !x.parentId)
    if (editing.value && !editing.value.parentId) {
      const i = list.findIndex((x) => x.id === editing.value!.id)
      return i > 0 ? `${list[i - 1]!.code} ${list[i - 1]!.name}` : '无（第一个节点）'
    }
    const last = list.at(-1)
    return last ? `${last.code} ${last.name}（排在最后时）` : '无'
  })
  /** 汇总行（有子节点）：日期由子节点算、不设前置 */
  const isSummary = computed(() => !!editing.value?.childCount)

  return { editOpen, editing, form, openEdit, predOptions, phaseOptions, parentOptions, formParent, defaultPredText, isSummary }
}
