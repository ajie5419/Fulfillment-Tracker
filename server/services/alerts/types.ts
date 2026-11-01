import type { AlertLevel, StepMode } from '@prisma/client'
import type { ScanRule } from './rules'

/** 一个处在规则关注状态的对象（不一定已到阈值） */
export interface Target {
  rule: ScanRule
  refType: 'step' | 'part' | 'unmatched' | 'issue' | 'receipt' | 'release' | 'purchase' | 'drawing' | 'node' | 'plan' | 'planNode' | 'planConfirm' | 'planSplit'
  refId: string
  key: string
  workOrderNumber: string | null
  /** 责任人 */
  ownerIds: string[]
  /** 黄色起额外通知的人（W5：发放人，要知道谁一直没签收 / 变更影响一直没人确认；W6：有没付的卡交期付款申请时加财务） */
  watcherIds?: string[]
  /** 黄色起要通知的"责任部门"名称；不给时取责任人所在部门（W4 的责任部门是异常上明确写的） */
  deptNames?: string[]
  /** 计时起点（W3 为承诺返回日） */
  startAt: Date
  /** 按当前时长/日期算出的级别，没到阈值为 null */
  level: AlertLevel | null
  /** 标题里冒号前的部分，如"主梁结构件 · 涂装" */
  subject: string
  /** 标题里冒号后的部分，如"组焊返厂 2 天仍未发出" */
  summary: string
  /** 转异常时定分类用；W5 带发放单 ID（跳转用） */
  meta?: { stepMode?: StepMode; supplierId?: string | null; releaseId?: string; link?: string }
}

// ───────────── 扫描 ─────────────

export interface ScanResult {
  skipped: boolean
  created: number
  escalated: number
  cleared: number
  reminders: number
  active: number
  /** 本轮红色自动转成异常的条数 */
  converted: number
}
