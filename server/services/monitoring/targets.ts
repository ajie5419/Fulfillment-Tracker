import type { Target } from '../alerts/scan'
import type { MonitoredEntity } from './status'
import { stagnationKey } from './rules'

/** 黄线只进入关注清单；扫描只收红线对象，因此回落红线以下会走原有 clear 机制。W11 不自动转异常。 */
export function stagnationTargets(entities: MonitoredEntity[]): Target[] {
  return entities.filter((e) => e.level === 'RED').map((e) => ({
    rule: 'W11', refType: e.entityType, refId: e.id, key: stagnationKey(e), workOrderNumber: e.workOrderNumber,
    // 留出状态、天数和最长 64 字的工单号空间，避免提醒标题的 190 字截断把必要信息裁掉。
    ownerIds: e.ownerIds, deptNames: e.deptNames, startAt: e.since, level: 'RED', subject: e.name.length > 80 ? `${e.name.slice(0, 79)}…` : e.name,
    summary: `${e.entityType === 'step' ? '工序' : '工件'}处于“${e.statusText}”已停 ${e.days} 天`,
    meta: { link: e.link },
  }))
}
