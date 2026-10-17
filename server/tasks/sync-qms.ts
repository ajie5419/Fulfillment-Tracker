import { runSyncJob } from '../services/sync/job'

/**
 * QMS 数据同步（技术选型第 4 节），由 nuxt.config 的 scheduledTasks 每 5 分钟触发：
 * 按游标依次拉 7 类资源写入只读副本 → 对新报检执行返厂匹配 → QMS 不合格转异常。
 * QMS 未配置（NUXT_QMS_SYNC_ENABLED=0 或地址、凭据为空）时跳过，不报错。日志里不打印密钥。
 */
export default defineTask({
  meta: { name: 'sync-qms', description: '增量同步 QMS 数据；返厂匹配；QMS 不合格转异常' },
  async run() {
    const result = await runSyncJob({ config: qmsSyncConfig(), adminIds: adminIds() })
    if (result.skipped !== 'not-configured') console.log(`[sync-qms] ${new Date().toISOString()} ${JSON.stringify(summary(result))}`)
    return { result }
  },
})

/** 日志摘要：每类资源的状态和行数 */
function summary(r: Awaited<ReturnType<typeof runSyncJob>>) {
  if (r.skipped) return { skipped: r.skipped }
  return {
    resources: r.sync?.resources.map((x) => `${x.resource}:${x.status}:${x.rows}${x.error ? `(${x.error})` : ''}`),
    alerted: r.sync?.alerted,
    match: r.match,
    nonconforming: r.nonconforming,
  }
}
