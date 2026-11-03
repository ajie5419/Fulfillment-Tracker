import { describe, expect, it } from 'vitest'
import { aggregatePanorama, filterPanoramaRows, PANORAMA_METRICS, panoramaDestination, type PanoramaRow } from '../../shared/panorama'
import { resolveBoardView } from '../../shared/board-cockpit'

const rows: PanoramaRow[] = [
  { status: 'IN_PROGRESS', color: 'RED', projectManagerId: 'pm', projectManagerName: '经理', productLine: 'A' },
  { status: 'IN_PROGRESS', color: 'YELLOW', projectManagerId: null, projectManagerName: null, productLine: null },
  { status: 'IN_PROGRESS', color: 'GREEN', projectManagerId: 'pm', projectManagerName: '经理', productLine: 'A' },
  { status: 'OPEN', color: 'RED', projectManagerId: null, projectManagerName: null, productLine: null },
  { status: 'COMPLETED', color: 'RED', projectManagerId: 'pm', projectManagerName: '经理', productLine: 'A' },
  { status: 'CANCELLED', color: 'RED', projectManagerId: 'pm', projectManagerName: '经理', productLine: 'A' },
]

describe('全盘统计下钻口径', () => {
  it('每张统计卡与清单的分母和状态一致，取消不计数', () => {
    const stats = aggregatePanorama(rows)
    for (const metric of PANORAMA_METRICS) {
      expect(filterPanoramaRows(rows, { metric: metric.value })).toHaveLength(stats.counts[metric.value])
    }
    expect(stats.counts).toMatchObject({ inProgress: 3, normal: 1, abnormal: 2, completed: 1, notStarted: 1, unaccepted: null })
  })

  it('经理及产品线分组含空值，风险数与下钻逐组一致', () => {
    const stats = aggregatePanorama(rows)
    for (const group of stats.byManager) {
      expect(filterPanoramaRows(rows, { manager: group.projectManagerId ?? '', metric: 'inProgress' })).toHaveLength(group.inProgress)
      expect(filterPanoramaRows(rows, { manager: group.projectManagerId ?? '', metric: 'abnormal' })).toHaveLength(group.abnormal)
    }
    for (const group of stats.byProductLine) {
      expect(filterPanoramaRows(rows, { productLine: group.productLine ?? '', metric: 'inProgress' })).toHaveLength(group.inProgress)
      expect(filterPanoramaRows(rows, { productLine: group.productLine ?? '', metric: 'abnormal' })).toHaveLength(group.abnormal)
    }
    expect(filterPanoramaRows(rows, { manager: '', productLine: '', metric: 'abnormal' })).toHaveLength(1)
    expect(filterPanoramaRows(rows, { manager: 'missing' })).toEqual([])
  })

  it('只使用已授权传入行，空 scope 不扩大，未知参数不改变口径', () => {
    expect(aggregatePanorama([]).counts.inProgress).toBe(0)
    expect(filterPanoramaRows([], { metric: 'completed' })).toEqual([])
    const visible = rows.slice(1, 2)
    expect(aggregatePanorama(visible).counts.abnormal).toBe(1)
    expect(filterPanoramaRows(visible, { metric: ['abnormal'], closed: '0', color: 'RED' })).toEqual(visible)
  })
})

describe('全景兼容链接及页签权限', () => {
  it.each([true, false])('旧链接保留可用参数、空分组和锚点，mobile=%s', mobile => {
    const query = { manager: '', productLine: 'A / 中文', metric: 'abnormal', wo: 'WO-01', view: 'cockpit', extra: ['a', 'b'] }
    const destination = panoramaDestination(mobile, query, '#orders')
    expect(destination).toEqual({ path: mobile ? '/m/board' : '/board', query: { ...query, view: 'panorama' }, hash: '#orders' })
    expect(query.view).toBe('cockpit')
  })
  it('统计人人可看但驾驶舱权限不扩大', () => {
    expect(resolveBoardView(false, 'panorama')).toBe('panorama')
    expect(resolveBoardView(true, 'panorama')).toBe('panorama')
    expect(resolveBoardView(false, 'cockpit')).toBe('board')
    expect(resolveBoardView(false, undefined)).toBe('board')
    expect(resolveBoardView(true, undefined)).toBe('cockpit')
  })
})
