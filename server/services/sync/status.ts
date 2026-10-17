/** QMS 同步状态：看板顶部的"QMS 最后同步时间"、设置页的"QMS 同步状态"表。 */
import { prisma } from '../../utils/prisma'
import { RESOURCE_TEXT, SYNC_RESOURCES, type SyncResource } from './client'

/** 每类资源一行（还没同步过的也列出） */
export async function syncStatus() {
  const cursors = new Map((await prisma.syncCursor.findMany()).map((c) => [c.resource, c]))
  return SYNC_RESOURCES.map((resource) => {
    const c = cursors.get(resource)
    return {
      resource,
      label: RESOURCE_TEXT[resource],
      lastSyncedAt: c?.lastSyncedAt ?? null,
      lastRunAt: c?.lastRunAt ?? null,
      since: c?.since ?? null,
      afterId: c?.afterId ?? null,
      lastError: c?.lastError ?? null,
      failCount: c?.failCount ?? 0,
      alertedAt: c?.alertedAt ?? null,
    }
  })
}

export interface SyncOverview {
  /** 各类资源最后成功追平时间的最小值（最旧的那类）；有资源从没同步成功过时为 null */
  lastSyncAt: Date | null
  /** 最旧的是哪类 */
  oldest: string | null
  /** 当前报错的资源 */
  errors: { resource: SyncResource; label: string; lastError: string; failCount: number }[]
}

export async function syncOverview(): Promise<SyncOverview> {
  const rows = await syncStatus()
  const synced = rows.filter((r) => r.lastSyncedAt)
  const oldest = synced.length === rows.length ? synced.reduce((a, b) => (+a.lastSyncedAt! <= +b.lastSyncedAt! ? a : b)) : null
  return {
    lastSyncAt: oldest?.lastSyncedAt ?? null,
    oldest: oldest?.label ?? null,
    errors: rows.filter((r) => r.failCount > 0 && r.lastError).map((r) => ({ resource: r.resource, label: r.label, lastError: r.lastError!, failCount: r.failCount })),
  }
}
