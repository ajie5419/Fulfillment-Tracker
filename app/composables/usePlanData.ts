import { computed, onMounted, ref, watch, type Ref } from 'vue'
import type { ClientResponse } from '../utils/transport'

/** GET /api/plan 的返回（总计划编辑器的数据源） */
export type PlanData = ClientResponse<'/api/plan', 'GET'>
/** 通用动作包装：成功提示 → 失败提示 → 无论成败都重新加载并通知 changed；失败返回 undefined */
export type PlanAct = <T>(fn: () => Promise<T>, ok?: string | ((r: T) => string)) => Promise<T | undefined>

/**
 * 总计划编辑器的数据加载与动作包装（PlanEditor 拆分）：
 * load 按工单加载，wo 变化 / 挂载时重载；加载成功后交给 afterLoad（定位节点等联动）；act 包装所有写操作。
 */
export function usePlanData(options: { wo: Ref<string>; afterLoad: (data: PlanData) => Promise<void>; onChanged: () => void }) {
  const { wo, afterLoad, onChanged } = options
  const data = ref<PlanData | null>(null)
  const loading = ref(false)
  const loadError = ref<string | null>(null)
  async function load() {
    if (!wo.value) {
      data.value = null
      return
    }
    loading.value = true
    loadError.value = null
    try {
      data.value = await clientRequest('/api/plan', { query: { workOrderNumber: wo.value } })
      await afterLoad(data.value)
    } catch (e) {
      data.value = null
      loadError.value = apiError(e)
    } finally {
      loading.value = false
    }
  }
  watch(wo, load)
  onMounted(load)

  const published = computed(() => data.value?.plan?.status === 'PUBLISHED')

  const act: PlanAct = async (fn, ok) => {
    try {
      const r = await fn()
      if (ok) message.success(typeof ok === 'function' ? ok(r) : ok)
      return r
    } catch (e) {
      message.error(apiError(e))
    } finally {
      await load()
      onChanged()
    }
  }

  /** 展开行里任务有变动（负责人标完成 / 撤销）*/
  async function onWorkChanged() {
    await load()
    onChanged()
  }

  return { data, loading, loadError, load, published, act, onWorkChanged }
}
