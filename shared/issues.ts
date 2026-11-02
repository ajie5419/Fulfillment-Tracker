/** 异常闭环状态。 */
export const ISSUE_STATUS_TEXT = { OPEN: '待受理', ACCEPTED: '处理中', RESOLVED: '待确认', CLOSED: '已关闭' } as const

/** 异常来源。 */
export const ISSUE_SOURCE_TEXT = { MANUAL: '手工上报', ALERT: '预警转入', QMS_NONCONFORMING: 'QMS 不合格', SCRAP: '完工报废' } as const

/** 异常分类。 */
export const ISSUE_CATEGORY_TEXT = {
  DESIGN: '设计',
  CHANGE: '变更',
  MATERIAL_PAYMENT: '物料-付款原因',
  MATERIAL_MGMT: '物料-管理原因',
  OUTSOURCE_SCHEDULE: '外协-进度',
  OUTSOURCE_QUALITY: '外协-质量',
  WORKSHOP: '车间',
  CUSTOMER: '客户',
  OTHER: '其他',
} as const
