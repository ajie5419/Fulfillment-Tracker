import { scanRules } from '../services/alerts/scan'

/** 预警扫描（技术选型第 5 节），由 nuxt.config 的 scheduledTasks 每 15 分钟触发。失败时下一轮自动重跑 */
export default defineTask({
  meta: { name: 'scan-rules', description: '执行 W1–W3：新建、升级、消除预警并写入提醒' },
  async run() {
    const result = await scanRules()
    console.log(`[scan-rules] ${new Date().toISOString()} ${JSON.stringify(result)}`)
    return { result }
  },
})
