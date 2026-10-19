/**
 * 部门工作台的"按工单分组 / 表格"切换（前端改版第二轮）：默认按工单分组，写进地址栏 ?layout=group|table 便于分享。
 */
export type ListLayout = 'group' | 'table'

export function useListLayout() {
  const route = useRoute()
  const router = useRouter()
  const layout = ref<ListLayout>(route.query.layout === 'table' ? 'table' : 'group')
  watch(layout, (v) => router.replace({ query: { ...route.query, layout: v } }))
  return layout
}
