/**
 * 同步任务的一整轮：同步 → 返厂匹配 → QMS 不合格转异常（server/tasks/sync-qms.ts 每 5 分钟、演示工具"立即同步一次"调用）。
 * job_lock 租约（sync-qms）防重叠，拿不到直接返回 skipped。QMS 未配置时什么都不做。
 * 匹配、不合格转异常只在报检同步成功时做；scan-rules 里的不合格扫描保留作兜底。
 */
import { matchPendingInspections } from '../flow/match'
import { syncNonconforming } from '../issues/nonconforming'
import { withLease } from '../jobs/lease'
import { syncConfigured } from './client'
import { type SyncOptions, type SyncResult, syncQms } from './sync'

const LOCK_NAME = 'sync-qms'
/** 租约：远大于一轮同步的耗时（每次请求最多 15 秒超时）；进程崩溃后最多这么久自动失效 */
const LEASE_MS = 15 * 60_000

export interface SyncJobResult {
  skipped?: 'not-configured' | 'running'
  sync?: SyncResult
  match?: { matched: number; unmatched: number; other: number } | { error: string }
  nonconforming?: { created: number; existed: number } | { error: string }
}

/** 一步失败不影响后面的步骤，下一轮自动重跑 */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn()
  } catch (err) {
    console.error(`[sync-qms] ${name} 失败`, err)
    return { error: String((err as Error)?.message ?? err) }
  }
}

export async function runSyncJob(opts: SyncOptions): Promise<SyncJobResult> {
  if (!syncConfigured(opts.config)) return { skipped: 'not-configured' }
  const r = await withLease(LOCK_NAME, LEASE_MS, async (): Promise<SyncJobResult> => {
    const sync = await syncQms(opts)
    if (!sync.inspectionsOk) return { sync }
    const match = await step('返厂匹配', async () => {
      const results = await matchPendingInspections()
      const matched = results.filter((x) => x.status === 'matched').length
      const unmatched = results.filter((x) => x.status === 'unmatched').length
      return { matched, unmatched, other: results.length - matched - unmatched }
    })
    const nonconforming = await step('QMS 不合格转异常', async () => {
      const n = await syncNonconforming()
      return { created: n.created.length, existed: n.existed }
    })
    return { sync, match, nonconforming }
  })
  return r.skipped ? { skipped: 'running' } : r.value
}
