import type { LocationQueryRaw } from 'vue-router'

/**
 * 一次性定位参数（提醒、搜索、留言跳过来带的 ?step= / ?stepId= / ?part= / ?edit= / comments=1 等）：
 *   - 每次进来只处理一次，处理完立刻从地址栏删掉——之后刷新数据、切页签都不会再被拉回去（再点一次提醒会重新带上，照常处理）；
 *   - ready() 为 false（数据还在加载、列表还是上一个工单的）时先不处理，等它变 true；
 *   - handler 返回 false 表示"这次处理不了"（如已跳去别的页面），既不算处理过也不删参数；
 *     返回对象时作为地址栏的额外改动一并写入（如手机端定位后把范围写成 mine=0，免得删了 stepId 范围跟着变）。
 * 用户手动切换（页签、分段、范围）时，调用方自己的写回地址栏逻辑也要删掉这些参数，参数只对"刚进来那一下"有效。
 * 见 docs/前端设计规范.md 第 4 节第 7 条。
 */
export function useOneShotQuery(
  keys: readonly string[],
  ready: () => boolean,
  handler: (values: Record<string, string>) => void | false | LocationQueryRaw,
) {
  const route = useRoute()
  const router = useRouter()
  // 已处理过的那组值：在它从地址栏消失之前（删除还没生效、或别的写回地址栏的逻辑照抄 query 又带回来）不再处理，只再删一次；
  // 地址栏里没有这些参数了就忘掉它——之后同样的值再出现（又点了一次提醒）照常处理
  let handled: string | null = null
  const cleared = () => Object.fromEntries(keys.map((k) => [k, undefined]))

  function run() {
    if (!import.meta.client) return
    const values: Record<string, string> = {}
    for (const k of keys) {
      const v = route.query[k]
      if (typeof v === 'string' && v) values[k] = v
    }
    if (!Object.keys(values).length) {
      handled = null
      return
    }
    const sig = keys.map((k) => `${k}=${values[k] ?? ''}`).join('&')
    if (sig === handled) {
      router.replace({ query: { ...route.query, ...cleared() } })
      return
    }
    if (!ready()) return
    const r = handler(values)
    if (r === false) return
    handled = sig
    router.replace({ query: { ...route.query, ...(r ?? {}), ...cleared() } })
  }

  onMounted(run)
  watch([() => keys.map((k) => route.query[k]), ready], run)
  /** 给调用方写回地址栏时用：把这些一次性参数置空 */
  return { cleared }
}
