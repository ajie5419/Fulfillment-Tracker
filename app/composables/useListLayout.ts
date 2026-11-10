/**
 * 部门工作台的"按工单分组 / 表格"切换（前端改版第二轮）：默认按工单分组，写进地址栏 ?layout=group|table 便于分享。
 */
export type ListLayout = 'group' | 'board' | 'table'

export function useListLayout(defaultLayout: ListLayout = 'group') {
  const route = useRoute()
  const router = useRouter()
  const initial = route.query.layout === 'table'
    ? 'table'
    : route.query.layout === 'board'
      ? 'board'
      : route.query.layout === 'group'
        ? 'group'
        : defaultLayout
  const layout = ref<ListLayout>(initial)
  watch(layout, (v) => router.replace({ query: { ...route.query, layout: v } }))
  return layout
}

/** "按工单 / 表格"切换的选项（设计规范：用 a-segmented，各页统一文字） */
export const LAYOUT_OPTIONS = [
  { value: 'group', label: '按工单' },
  { value: 'table', label: '表格' },
]

/** 设计任务支持按工单、按阶段看板、表格三种视图 */
export const DRAWING_LAYOUT_OPTIONS = [
  { value: 'group', label: '按工单' },
  { value: 'board', label: '按阶段看板' },
  { value: 'table', label: '表格' },
]
