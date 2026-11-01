/** 工序状态。 */
export const STEP_STATUS_TEXT = { PENDING: '待开工', OUT: '在外加工', IN_PROGRESS: '加工中', DONE: '已完成', BLOCKED: '有异常' } as const

/** 工序加工方式。 */
export const STEP_MODE_TEXT = { SELF: '自制', IN_PLANT_OUTSOURCE: '厂内外协', EXTERNAL_OUTSOURCE: '厂外外协' } as const

/** 工序流转事件。 */
export const FLOW_EVENT_TEXT = { SEND: '发出', RETURN: '返厂（QMS 报检）', RETURN_MANUAL: '补登返厂', START: '开工', FINISH: '完工', REPORT: '部分完工', SCRAP: '报废' } as const

/** 流转记录来源。 */
export const FLOW_SOURCE_TEXT = { MOBILE: '手机', QMS_INSPECTION: 'QMS', PC: '电脑' } as const
