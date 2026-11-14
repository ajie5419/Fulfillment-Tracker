import { computed, nextTick, ref, watch } from 'vue'
import { factoryDay } from '#shared/mobile-todo'
import type { PlanData } from './usePlanData'

/**
 * 总计划的节点定位与表格 / 甘特图切换（PlanEditor 拆分）：
 * 地址栏 ?node= 定位节点（W9 提醒、任务待办跳过来）；甘特图点节点切回表格并定位。
 */
export function usePlanFocus(options: { reveal: (id: string) => void; reload: () => Promise<void> }) {
  const { reveal, reload } = options
  const route = useRoute()
  const focusNode = ref<string | null>((route.query.node as string) || null)
  const expanded = ref<string[]>([])
  const view = ref<'table' | 'gantt'>('table')
  const today = computed(() => factoryDay(new Date()))

  /** 加载完成后：地址栏指定的节点存在就展开并滚动到它 */
  async function afterLoad(data: PlanData) {
    if (focusNode.value && data.nodes.some((n) => n.id === focusNode.value)) {
      reveal(focusNode.value)
      expanded.value = [focusNode.value]
      await nextTick()
      document.querySelector(`[data-row-key="${focusNode.value}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }
  watch(
    () => route.query.node,
    (v) => {
      focusNode.value = (v as string) || null
      void reload()
    },
  )
  function selectFromGantt(id: string) {
    view.value = 'table'
    focusNode.value = id
    reveal(id)
    expanded.value = [id]
    void nextTick(() => document.querySelector(`[data-row-key="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }

  return { focusNode, expanded, view, today, afterLoad, selectFromGantt }
}
