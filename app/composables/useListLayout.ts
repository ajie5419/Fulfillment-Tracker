/**
 * 部门工作台的"按工单分组 / 表格"切换（前端改版第二轮）：默认按工单分组，写进地址栏 ?layout=group|table 便于分享。
 */
const LAYOUT_PREFERENCE_MAX_AGE = 365 * 24 * 60 * 60

export type ListLayout = 'group' | 'board' | 'table'

export function useListLayout(defaultLayout: ListLayout = 'group', preferenceKey?: string) {
  const route = useRoute()
  const router = useRouter()
  const preference = preferenceKey ? useCookie<ListLayout | null>(preferenceKey, { sameSite: 'lax', maxAge: LAYOUT_PREFERENCE_MAX_AGE }) : null
  const valid = (value: unknown): value is ListLayout => value === 'group' || value === 'board' || value === 'table'
  /** Explicit links win over remembered layouts, including browser back/forward navigation. */
  const resolveLayout = () => valid(route.query.layout) ? route.query.layout : valid(preference?.value) ? preference.value : defaultLayout
  const layout = ref<ListLayout>(resolveLayout())
  watch(layout, (v) => {
    if (preference) preference.value = v
    if (route.query.layout !== v) router.replace({ query: { ...route.query, layout: v } })
  })
  watch(() => route.query.layout, () => { layout.value = resolveLayout() })
  return layout
}

/** "按工单 / 表格"切换的选项（设计规范：用 a-segmented，各页统一文字） */
export const LAYOUT_OPTIONS = [
  { value: 'group', label: '按工单' },
  { value: 'table', label: '表格' },
]

/** 设计任务支持按工单、按阶段看板、表格三种视图 */
export const DRAWING_LAYOUT_OPTIONS = [
  { value: 'group', label: '工单分组' },
  { value: 'board', label: '阶段看板' },
  { value: 'table', label: '明细表' },
]
