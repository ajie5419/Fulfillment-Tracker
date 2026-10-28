/**
 * 同步任务的一整轮：同步 → 返厂匹配 → 进货检验确认到货（R10）→ QMS 不合格转异常（server/tasks/sync-qms.ts 每 5 分钟、演示工具"立即同步一次"调用）。
 * job_lock 租约（sync-qms）防重叠，拿不到直接返回 skipped。QMS 未配置时什么都不做。
 * 匹配、不合格转异常只在报检同步成功时做；scan-rules 里的不合格扫描保留作兜底。
 */
import { matchPendingInspections } from '../flow/match'
import { syncNonconforming } from '../issues/nonconforming'
import { matchIncomingInspections } from '../purchases/incoming'
import { LeaseLostError, withLease } from '../jobs/lease'
import { syncConfigured } from './client'
import { type SyncOptions, type SyncResult, syncQms } from './sync'

const LOCK_NAME = 'sync-qms'
/** Renewed by each write transaction; a stalled worker loses permission to write after this interval. */
const LEASE_MS = 15 * 60_000

export interface SyncJobResult {
  skipped?: 'not-configured' | 'running'
  sync?: SyncResult
  match?: { matched: number; unmatched: number; other: number } | { error: string }
  incoming?: { arrived: number; other: number } | { error: string }
  nonconforming?: { created: number; existed: number } | { error: string }
}

/** 一步失败不影响后面的步骤，下一轮自动重跑 */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof LeaseLostError) throw err
    console.error(`[sync-qms] ${name} 失败`, err)
    return { error: String((err as Error)?.message ?? err) }
  }
}

export async function runSyncJob(opts: SyncOptions): Promise<SyncJobResult> {
  if (!syncConfigured(opts.config)) return { skipped: 'not-configured' }
  const r = await withLease(LOCK_NAME, LEASE_MS, async (lease): Promise<SyncJobResult> => {
    const sync = await syncQms({ ...opts, lease })
    if (!sync.inspectionsOk) return { sync }
    const match = await step('返厂匹配', async () => {
      const results = await matchPendingInspections(lease)
      const matched = results.filter((x) => x.status === 'matched').length
      const unmatched = results.filter((x) => x.status === 'unmatched').length
      return { matched, unmatched, other: results.length - matched - unmatched }
    })
    const incoming = await step('进货检验确认到货', async () => {
      const results = await matchIncomingInspections(lease)
      const arrived = results.filter((x) => x.result === 'MATCHED').length
      return { arrived, other: results.length - arrived }
    })
    const nonconforming = await step('QMS 不合格转异常', async () => {
      const n = await syncNonconforming(lease)
      return { created: n.created.length, existed: n.existed }
    })
    return { sync, match, incoming, nonconforming }
  })
  return r.skipped ? { skipped: 'running' } : r.value
}
