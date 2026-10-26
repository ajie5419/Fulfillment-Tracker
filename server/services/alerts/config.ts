/** 预警规则的可配置项：阈值表、停工日。扫描、预警列表、异常列表、看板共用。 */
import { ALERT_RULES } from '../../../shared/alert-rules'
import { prisma } from '../../utils/prisma'
import { DEFAULT_THRESHOLDS, type ScanRule, type Thresholds, dateFieldDay } from './rules'

export const SCAN_RULES: ScanRule[] = [...ALERT_RULES]

export async function loadThresholds(): Promise<Thresholds> {
  const rows = await prisma.threshold.findMany({ where: { rule: { in: SCAN_RULES } } })
  const t: Thresholds = structuredClone(DEFAULT_THRESHOLDS)
  for (const r of rows) t[r.rule as ScanRule] = { remindHours: r.remindHours, yellowDays: r.yellowDays, redDays: r.redDays }
  return t
}

export async function loadOffDays(): Promise<string[]> {
  return (await prisma.offDay.findMany()).map((d) => dateFieldDay(d.date))
}
