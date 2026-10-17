/**
 * sync-qms：按游标依次增量拉取 7 类资源，写入 QMS 只读副本（技术选型第 4 节，验收 A8 幂等与中断）。
 *
 * 每类资源循环翻页直到 nextCursor 为 null（已追平），单次运行最多 maxPages 页防死循环（没追平的下一轮接着拉）。
 * 每页写入与推进该资源的 sync_cursor（since、afterId）在同一事务里；整轮成功后才清空 lastError、failCount 归零：
 * 中途失败时已提交的页不回滚、游标停在最后成功的一页，下一轮从这里续跑，不重复、不丢。
 * 同一 updatedAt 的多行靠 (updatedAt, key) 复合游标区分。
 *
 * 某类资源失败：记 lastError、failCount + 1，依赖它的步骤本轮跳过（报检依赖 工单/外协单位/厂内班组/工序：
 * 报检上的班组还没同步时匹配会落空进"待确认"）；已推进的游标不受影响，其他资源照常同步。
 * 连续失败 3 次：给管理员（NUXT_ADMIN_USER_IDS）发一条"我的提醒"（置顶），同一轮故障只发一次；
 * 恢复（该资源同步成功）后清除标记，之后再连续失败 3 次会再发。
 */
import type { SyncCursor } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { type QmsSyncConfig, QmsSyncError, RESOURCE_TEXT, SYNC_RESOURCES, type SyncResource, fetchSyncPage, formatIssues } from './client'
import { RESOURCES } from './resources'

/** 报检依赖的资源：这些本轮失败时，报检和之后的匹配、不合格转异常都跳过 */
export const DEPENDS_ON: Partial<Record<SyncResource, SyncResource[]>> = {
  inspections: ['work-orders', 'suppliers', 'teams', 'processes'],
}

/** 连续失败多少次提醒管理员 */
export const ALERT_AFTER_FAILURES = 3
/** 每类资源单次运行最多拉多少页（每页 limit 行） */
export const DEFAULT_MAX_PAGES = 200
export const PAGE_LIMIT = 100

export interface ResourceResult {
  resource: SyncResource
  status: 'ok' | 'partial' | 'failed' | 'skipped'
  pages: number
  rows: number
  error?: string
}

export interface SyncResult {
  resources: ResourceResult[]
  /** 报检同步成功（含本轮到页数上限但没出错）：可以接着匹配 */
  inspectionsOk: boolean
  /** 本轮给管理员发了同步失败提醒的人数 */
  alerted: number
}

export interface SyncOptions {
  config: QmsSyncConfig
  /** 管理员 QMS 用户 ID（连续失败提醒的收件人） */
  adminIds: string[]
  fetchImpl?: typeof fetch
  maxPages?: number
  pageLimit?: number
  /** 只同步这些资源（测试用），默认全部 */
  only?: SyncResource[]
}

const errorText = (err: unknown) => {
  if (err instanceof QmsSyncError) return err.message
  const msg = String((err as Error)?.message ?? err)
  return `写入失败：${msg}`.slice(0, 1000)
}

async function loadCursor(resource: SyncResource): Promise<SyncCursor> {
  return prisma.syncCursor.upsert({ where: { resource }, create: { resource }, update: {} })
}

/** 同步一类资源：翻页直到追平或到页数上限；出错时记录并返回 failed */
export async function syncResource(resource: SyncResource, opts: SyncOptions): Promise<ResourceResult> {
  const def = RESOURCES[resource]
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES
  const cursor = await loadCursor(resource)
  let since = cursor.since
  let afterId = cursor.afterId
  const result: ResourceResult = { resource, status: 'ok', pages: 0, rows: 0 }
  await prisma.syncCursor.update({ where: { resource }, data: { lastRunAt: new Date() } })
  try {
    for (;;) {
      if (result.pages >= maxPages) {
        result.status = 'partial' // 没追平，下一轮接着拉；不算失败
        break
      }
      const page = await fetchSyncPage(opts.config, resource, { since, afterId }, opts.pageLimit ?? PAGE_LIMIT, opts.fetchImpl)
      const rows = page.items.map((item, i) => {
        const r = def.schema.safeParse(item)
        if (!r.success) throw new QmsSyncError(`第 ${i + 1} 行字段不符：${formatIssues(r.error)}`)
        return r.data
      })
      const last = rows.at(-1)
      // 游标 = 本页最后一行的 (updatedAt, key)；接口给了 nextCursor 时以它为准
      const next = page.nextCursor ?? (last ? { since: last.updatedAt, afterId: def.key(last) } : null)
      if (page.nextCursor && since && afterId && +next!.since === +since && next!.afterId === afterId) {
        throw new QmsSyncError('QMS 返回的游标没有前进，已停止本轮同步以免死循环')
      }
      const caughtUp = !page.nextCursor
      await prisma.$transaction(async (tx) => {
        await def.write(tx, rows)
        await tx.syncCursor.update({
          where: { resource },
          data: {
            ...(next ? { since: next.since, afterId: next.afterId } : {}),
            ...(caughtUp ? { lastSyncedAt: new Date() } : {}),
          },
        })
      })
      if (next) {
        since = next.since
        afterId = next.afterId
      }
      result.pages++
      result.rows += rows.length
      if (caughtUp) break
    }
    // 整轮跑完（追平或到页数上限）才清零失败计数：前几页成功、后面某页失败时，失败次数要能连续累加到提醒阈值
    await prisma.syncCursor.update({ where: { resource }, data: { lastError: null, failCount: 0, alertedAt: null } })
  } catch (err) {
    const error = errorText(err)
    await prisma.syncCursor.update({ where: { resource }, data: { lastError: error, failCount: { increment: 1 } } })
    return { ...result, status: 'failed', error }
  }
  return result
}

/** 依次同步 7 类资源；失败的资源不影响其他资源，依赖它的跳过 */
export async function syncQms(opts: SyncOptions): Promise<SyncResult> {
  const results: ResourceResult[] = []
  const failed = new Set<SyncResource>()
  for (const resource of SYNC_RESOURCES) {
    if (opts.only && !opts.only.includes(resource)) continue
    const blockedBy = (DEPENDS_ON[resource] ?? []).filter((d) => failed.has(d))
    if (blockedBy.length) {
      failed.add(resource)
      results.push({ resource, status: 'skipped', pages: 0, rows: 0, error: `依赖的${blockedBy.map((d) => RESOURCE_TEXT[d]).join('、')}同步失败，本轮跳过` })
      continue
    }
    const r = await syncResource(resource, opts)
    if (r.status === 'failed') failed.add(resource)
    results.push(r)
  }
  const ins = results.find((r) => r.resource === 'inspections')
  const alerted = await alertAdminsIfNeeded(opts.adminIds)
  return { resources: results, inspectionsOk: !!ins && (ins.status === 'ok' || ins.status === 'partial'), alerted }
}

export const syncFailKey = (incidentAt: Date, userId: string) => `SYNC_FAIL:${incidentAt.toISOString()}:${userId}`

/**
 * 有资源连续失败 ≥ 3 次、且本轮故障还没提醒过（没有任何资源带 alertedAt）时，给每位管理员发一条红色提醒（kind = SYNC_FAIL，置顶）。
 * 发出后给所有正在失败的资源打上 alertedAt：同一轮故障里别的资源后来也到 3 次不再重复发；
 * 资源恢复时清掉自己的 alertedAt，全部恢复后再失败就是新一轮故障。
 */
export async function alertAdminsIfNeeded(adminIds: string[], now = new Date()): Promise<number> {
  const order = (c: SyncCursor) => SYNC_RESOURCES.indexOf(c.resource as SyncResource)
  const cursors = (await prisma.syncCursor.findMany()).sort((a, b) => order(a) - order(b))
  const failing = cursors.filter((c) => c.failCount > 0)
  const over = failing.filter((c) => c.failCount >= ALERT_AFTER_FAILURES)
  if (!over.length || cursors.some((c) => c.alertedAt) || !adminIds.length) return 0
  const label = (c: SyncCursor) => RESOURCE_TEXT[c.resource as SyncResource] ?? c.resource
  const title = `QMS 同步连续失败 ${Math.max(...over.map((c) => c.failCount))} 次：${over.map(label).join('、')}`
  const body = failing.map((c) => `${label(c)}：连续失败 ${c.failCount} 次，${c.lastError ?? ''}`).join('\n')
  return prisma.$transaction(async (tx) => {
    const r = await tx.reminder.createMany({
      data: adminIds.map((userId) => ({ userId, title, body, level: 'RED' as const, kind: 'SYNC_FAIL', dedupeKey: syncFailKey(now, userId) })),
      skipDuplicates: true,
    })
    await tx.syncCursor.updateMany({ where: { resource: { in: failing.map((c) => c.resource) } }, data: { alertedAt: now } })
    return r.count
  })
}
