import { generateDailyDigest } from '../services/alerts/digest'
import { scanRules } from '../services/alerts/scan'
import { syncNonconforming } from '../services/issues/nonconforming'

/** 一步失败不影响后面的步骤，失败的下一轮自动重跑 */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn()
  } catch (err) {
    console.error(`[scan-rules] ${name} 失败`, err)
    return { error: String((err as Error)?.message ?? err) }
  }
}

/**
 * 预警扫描（技术选型第 5 节），由 nuxt.config 的 scheduledTasks 每 15 分钟触发：
 * 1. QMS 不合格转异常（兜底：sync-qms 每轮同步后已做；先做，步骤先变"有异常"，W2 就不会对它的下一道计时）；
 * 2. W1–W6 扫描（W1–W3 红色自动转异常）；
 * 3. 每日汇总：工厂时区 07:30 以后、今天还没生成的补上（与服务器时区无关）。
 */
export default defineTask({
  meta: { name: 'scan-rules', description: 'QMS 不合格转异常；执行 W1–W6；生成每日汇总' },
  async run() {
    const nonconforming = await step('QMS 不合格转异常', syncNonconforming)
    const result = await step('预警扫描', () => scanRules())
    const digest = await step('每日汇总', () => generateDailyDigest({ adminIds: adminIds() }))
    console.log(`[scan-rules] ${new Date().toISOString()} ${JSON.stringify({ nonconforming, result, digest })}`)
    return { result: { nonconforming, scan: result, digest } }
  },
})
