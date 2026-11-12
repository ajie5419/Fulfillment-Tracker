import { observeTask } from '../observability/task'
import { logEvent } from '../observability/logger'
import { runSyncJob } from '../services/sync/job'

/**
 * QMS 数据同步（技术选型第 4 节），由 nuxt.config 的 scheduledTasks 每 5 分钟触发：
 * 按游标依次拉 7 类资源写入只读副本 → 对新报检执行返厂匹配 → 进货检验确认采购行到货（R10）→ QMS 不合格转异常。
 * QMS 未配置（NUXT_QMS_SYNC_ENABLED=0 或地址、凭据为空）时跳过，不报错。日志里不打印密钥。
 */
export default defineTask({
  meta: { name: 'sync-qms', description: '增量同步 QMS 数据；返厂匹配；进货检验确认到货；QMS 不合格转异常' },
  async run() {
    return observeTask('sync-qms', async () => {
      const result = await runSyncJob({ config: qmsSyncConfig(), adminIds: adminIds() })
      const incomplete = result.sync?.resources.some(x => x.status !== 'ok') || [result.match, result.incoming, result.nonconforming].some(x => x && 'error' in x)
      logEvent(incomplete ? 'warn' : 'info', 'sync.result', { resultCode: result.skipped ?? (incomplete ? 'partial-failure' : 'completed'), count: result.sync?.resources.reduce((sum, x) => sum + x.rows, 0) ?? 0 })
      return { result }
    })
  },
})
