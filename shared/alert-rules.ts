/**
 * 预警规则的唯一清单（前后端共用）：编号和名称只在这里改。
 * 新增规则时这里加一项，另外要改：prisma 的 AlertRule 枚举 + 迁移、services/alerts/rules.ts 的默认阈值、scan.ts 的收集函数、设置页的阈值说明。
 */
export const ALERT_RULES = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11'] as const
export type AlertRuleKey = (typeof ALERT_RULES)[number]

export const RULE_TEXT: Record<AlertRuleKey, string> = {
  W1: 'W1 待确认匹配超时',
  W2: 'W2 转序停滞',
  W3: 'W3 外协逾期未返',
  W4: 'W4 异常超期',
  W5: 'W5 发放未签收 / 变更未确认',
  W6: 'W6 关键物料未到货',
  W7: 'W7 设计逾期',
  W8: 'W8 装配节点未齐套',
  W9: 'W9 总计划节点延误 / 未确认',
  W10: 'W10 厂内工序逾期未完',
  W11: 'W11 在制状态停滞',
}
