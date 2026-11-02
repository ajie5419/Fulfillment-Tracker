/** GET /api/panorama；数量均在当前 actor 可见、未删除的工单范围内。 */
export interface PanoramaData {
  counts: {
    inProgress: number
    normal: number
    abnormal: number
    completed: number
    /** OPEN：未开工，不能用来推算未验收。 */
    notStarted: number
    unaccepted: null
    unacceptedAvailable: false
  }
  /** 分组含可见的在制、未开工、已完工工单；仅在制工单计入分组数字。 */
  byManager: {
    projectManagerId: string | null
    projectManagerName: string
    inProgress: number
    abnormal: number
  }[]
  /** null 表示未指定产品线。 */
  byProductLine: {
    productLine: string | null
    inProgress: number
    abnormal: number
  }[]
}
