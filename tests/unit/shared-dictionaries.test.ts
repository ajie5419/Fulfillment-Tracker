import { describe, expect, it } from 'vitest'
import { CONFIRM_TONE } from '../../app/utils/plan-status'
import { DRAWING_STATUS_TEXT } from '../../shared/drawing'
import { STEP_STATUS_TEXT, STEP_MODE_TEXT, FLOW_EVENT_TEXT, FLOW_SOURCE_TEXT } from '../../shared/flow'
import { ISSUE_STATUS_TEXT, ISSUE_SOURCE_TEXT, ISSUE_CATEGORY_TEXT } from '../../shared/issues'
import { MATERIAL_STATUS_TEXT, PROCESS_STATUS_TEXT } from '../../shared/process'
import { PURCHASE_STATUS_TEXT, DELAY_REASON_TEXT, PAYMENT_STATUS_TEXT } from '../../shared/purchases'
import { RELEASE_TYPE_TEXT, RECEIPT_STATUS_TEXT } from '../../shared/releases'
import { ALERT_LEVEL_TEXT } from '../../shared/alert-rules'
import { PLAN_CONFIRM_TEXT } from '../../shared/plan'
import { MAX_PHOTO_BYTES, MAX_ATTACHMENT_BYTES, MAX_BOM_BYTES, MAX_FILES_PER_REQUEST, MAX_ISSUE_PHOTOS, MAX_RELEASE_ATTACHMENTS } from '../../shared/upload-policy'

describe('共享状态字典保持搬家前全部键值', () => {
  it('PLAN_CONFIRM_TEXT', () => {
    expect(PLAN_CONFIRM_TEXT).toEqual({ PENDING: '待接收', CONFIRMED: '已接收', REJECTED: '已退回' })
  })

  it('CONFIRM_TONE', () => {
    expect(CONFIRM_TONE).toEqual({ PENDING: 'risk', CONFIRMED: 'done', REJECTED: 'late' })
  })

  it('DRAWING_STATUS_TEXT', () => {
    expect(DRAWING_STATUS_TEXT).toEqual({ PENDING: '设计中', DRAWN: '设计完成', CUSTOMER_PENDING: '待客户确认', DONE: '已完成', CANCELLED: '已取消' })
  })

  it('STEP_STATUS_TEXT', () => {
    expect(STEP_STATUS_TEXT).toEqual({ PENDING: '待开工', OUT: '在外加工', IN_PROGRESS: '加工中', DONE: '已完成', BLOCKED: '有异常' })
  })

  it('STEP_MODE_TEXT', () => {
    expect(STEP_MODE_TEXT).toEqual({ SELF: '自制', IN_PLANT_OUTSOURCE: '厂内外协', EXTERNAL_OUTSOURCE: '厂外外协' })
  })

  it('FLOW_EVENT_TEXT', () => {
    expect(FLOW_EVENT_TEXT).toEqual({ SEND: '发出', RETURN: '返厂（QMS 报检）', RETURN_MANUAL: '补登返厂', START: '开工', FINISH: '完工', REPORT: '部分完工', SCRAP: '报废' })
  })

  it('FLOW_SOURCE_TEXT', () => {
    expect(FLOW_SOURCE_TEXT).toEqual({ MOBILE: '手机', QMS_INSPECTION: 'QMS', PC: '电脑' })
  })

  it('ISSUE_STATUS_TEXT', () => {
    expect(ISSUE_STATUS_TEXT).toEqual({ OPEN: '待受理', ACCEPTED: '处理中', RESOLVED: '待确认', CLOSED: '已关闭' })
  })

  it('ISSUE_SOURCE_TEXT', () => {
    expect(ISSUE_SOURCE_TEXT).toEqual({ MANUAL: '手工上报', ALERT: '预警转入', QMS_NONCONFORMING: 'QMS 不合格', SCRAP: '完工报废' })
  })

  it('ISSUE_CATEGORY_TEXT', () => {
    expect(ISSUE_CATEGORY_TEXT).toEqual({
      DESIGN: '设计',
      CHANGE: '变更',
      MATERIAL_PAYMENT: '物料-付款原因',
      MATERIAL_MGMT: '物料-管理原因',
      OUTSOURCE_SCHEDULE: '外协-进度',
      OUTSOURCE_QUALITY: '外协-质量',
      WORKSHOP: '车间',
      CUSTOMER: '客户',
      OTHER: '其他',
    })

  })

  it('MATERIAL_STATUS_TEXT', () => {
    expect(MATERIAL_STATUS_TEXT).toEqual({ NOT_STARTED: '未开始', DRAFTING: '编制中', REVISING: '修改中', ISSUED: '已下发' })
  })

  it('PROCESS_STATUS_TEXT', () => {
    expect(PROCESS_STATUS_TEXT).toEqual({ NONE: '无', DRAFTING: '编制中', REVISING: '修改中', ISSUED: '已下发' })
  })

  it('PURCHASE_STATUS_TEXT', () => {
    expect(PURCHASE_STATUS_TEXT).toEqual({ OPEN: '未到货', ARRIVED: '已到货', CANCELLED: '已取消' })
  })

  it('DELAY_REASON_TEXT', () => {
    expect(DELAY_REASON_TEXT).toEqual({ PAYMENT: '付款', SUPPLIER: '供应商', DEMAND_CHANGE: '我方需求变化', OTHER: '其他' })
  })

  it('PAYMENT_STATUS_TEXT', () => {
    expect(PAYMENT_STATUS_TEXT).toEqual({ PENDING: '待付', PAID: '已付', ON_HOLD: '暂缓' })
  })

  it('RELEASE_TYPE_TEXT', () => {
    expect(RELEASE_TYPE_TEXT).toEqual({ DRAWING: '图纸', CHANGE: '设计变更', PROCESS: '工艺文件' })
  })

  it('RECEIPT_STATUS_TEXT', () => {
    expect(RECEIPT_STATUS_TEXT).toEqual({ PENDING: '待签收', SIGNED: '已签收', REJECTED: '已拒收', CANCELLED: '已作废' })
  })

  it('ALERT_LEVEL_TEXT', () => {
    expect(ALERT_LEVEL_TEXT).toEqual({ RED: '红色', YELLOW: '黄色', REMIND: '提醒' })
  })
})

describe('上传策略区分文件大小、请求数量与业务总数', () => {
  it('单文件大小维持照片 8MB、附件 20MB、BOM 5MB', () => {
    expect([MAX_PHOTO_BYTES, MAX_ATTACHMENT_BYTES, MAX_BOM_BYTES]).toEqual([8388608, 20971520, 5242880])
  })

  it('一条发放单允许分批上传到 5 个附件，每请求仍只允许 3 个', () => {
    expect(MAX_FILES_PER_REQUEST).toBe(3)
    expect(MAX_RELEASE_ATTACHMENTS).toBe(5)
    expect(MAX_RELEASE_ATTACHMENTS).toBeGreaterThan(MAX_FILES_PER_REQUEST)
  })

  it('异常记录最多绑定 3 张照片', () => {
    expect(MAX_ISSUE_PHOTOS).toBe(3)
  })
})
