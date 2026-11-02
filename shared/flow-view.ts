import type { Part, RouteStep } from '@prisma/client'

export interface PrereqState {
  /** 挂了至少一项（未取消的）物料或设计任务 */
  tracked: boolean
  /** 还没到货的物料数 */
  missingMaterial: number
  /** 还没下发的料单数（修改中也未满足） */
  missingMaterialList: number
  /** 还没完成的设计任务数 */
  missingDrawing: number
}

export interface RelatedCounts {
  drawings: number
  drawingsDone: number
  purchases: number
  purchasesArrived: number
  openIssues: number
  comments: number
}

/** 工件详情的服务数据类型；保留 Date 字段，HTTP 序列化仍由原接口完成。 */
export type PartDetail = Part & {
  related: RelatedCounts
  steps: (RouteStep & {
    processName: string
    supplierName: string | null
    ownerName: string | null
    /** 没有负责人、派到班组时由班组长负责；有负责人时为 null */
    leaderName: string | null
    returnedQty: number
    eventCount: number
    issues: { id: string; issueNo: string }[]
    needsFill: boolean
  })[]
  prereq: PrereqState
}
