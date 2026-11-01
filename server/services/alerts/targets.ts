import { closedWorkOrders } from '../workorder/active'
import { loadMonitoredEntities } from '../monitoring/status'
import { stagnationTargets } from '../monitoring/targets'
import { type ScanRule, type Thresholds } from './rules'
import type { Target } from './types'
import { collectW1, collectW2, collectW3, collectW10 } from './collectors/flow'
import { collectW4 } from './collectors/issues'
import { collectW5 } from './collectors/releases'
import { collectW6 } from './collectors/purchases'
import { collectW7 } from './collectors/drawings'
import { collectW8 } from './collectors/kitting'
import { collectW9 } from './collectors/plan'

/** 收集 W1–W11 关注的全部对象，并按 now 判定级别；only 只收集某一条规则 */
export async function collectTargets(now: Date, t: Thresholds, offDays: string[], only?: ScanRule): Promise<Target[]> {
  const run = (rule: ScanRule, fn: () => Promise<Target[]>) => (!only || only === rule ? fn() : Promise.resolve([]))
  const parts = await Promise.all([
    run('W1', () => collectW1(now, t, offDays)),
    run('W2', () => collectW2(now, t, offDays)),
    run('W3', () => collectW3(now, t, offDays)),
    run('W4', () => collectW4(now, t, offDays)),
    run('W5', () => collectW5(now, t, offDays)),
    run('W6', () => collectW6(now, t, offDays)),
    run('W7', () => collectW7(now, t, offDays)),
    run('W8', () => collectW8(now, t)),
    run('W9', () => collectW9(now, t, offDays)),
    run('W10', () => collectW10(now, t, offDays)),
    run('W11', async () => stagnationTargets(await loadMonitoredEntities(now, t.W11))),
  ])
  const all = parts.flat()
  // 工单已完工 / 已取消（zhao 10-22）：进度类预警（W2/W3/W5–W11）不再报，已有的本轮自动消除；
  // W1 待确认匹配（报检本身要处理）、W4 异常（人提出的问题要关闭）照常
  const closed = await closedWorkOrders(all.filter((x) => !KEEP_WHEN_CLOSED.has(x.rule) && x.workOrderNumber).map((x) => x.workOrderNumber!))
  return closed.size ? all.filter((x) => KEEP_WHEN_CLOSED.has(x.rule) || !x.workOrderNumber || !closed.has(x.workOrderNumber)) : all
}

/** 工单关闭后仍然照常预警的规则 */
const KEEP_WHEN_CLOSED: ReadonlySet<ScanRule> = new Set(['W1', 'W4'])
