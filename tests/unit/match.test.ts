import { describe, expect, it } from 'vitest'
import { type CandidateStep, type InspectionKey, findCandidates } from '../../server/services/flow/match'

const WO = 'WO-1'

function step(id: string, over: Partial<Omit<CandidateStep, 'part'>> & { part?: Partial<CandidateStep['part']> } = {}): CandidateStep {
  const { part, ...rest } = over
  return {
    id,
    status: 'OUT',
    mode: 'EXTERNAL_OUTSOURCE',
    processId: 'P-WELD',
    processName: '组焊',
    supplierId: 'S-1',
    ...rest,
    part: { workOrderNumber: WO, name: '主梁结构件', qmsPartId: 'BOM-1', ...part },
  }
}

function inspection(over: Partial<InspectionKey> = {}): InspectionKey {
  return { workOrderNumber: WO, partId: null, partName: '主梁结构件', processId: null, processName: '组焊', supplierId: null, ...over }
}

const ids = (steps: CandidateStep[]) => steps.map((s) => s.id)

describe('findCandidates', () => {
  it('物料 ID 路径：按 qmsPartId 匹配，不看名称和工序', () => {
    const steps = [
      step('a', { part: { qmsPartId: 'BOM-1', name: '名字不一样' }, processName: '涂装', processId: 'P-PAINT' }),
      step('b', { part: { qmsPartId: 'BOM-2' } }),
    ]
    expect(ids(findCandidates(inspection({ partId: 'BOM-1' }), steps))).toEqual(['a'])
  })

  it('名称路径：物料名称去首尾空格后相等，且工序 ID 相等', () => {
    const steps = [step('a', { part: { name: '主梁结构件 ' } }), step('b', { processId: 'P-PAINT', processName: '涂装' })]
    expect(ids(findCandidates(inspection({ partName: ' 主梁结构件', processId: 'P-WELD' }), steps))).toEqual(['a'])
  })

  it('名称路径：报检没有工序 ID 时比较工序名称', () => {
    const steps = [step('a'), step('b', { processId: 'P-PAINT', processName: '涂装' })]
    expect(ids(findCandidates(inspection({ processName: ' 涂装 ' }), steps))).toEqual(['b'])
  })

  it('报检带外协厂时，步骤外协厂必须相同', () => {
    const steps = [step('a', { supplierId: 'S-1' }), step('b', { supplierId: 'S-2' }), step('c', { supplierId: null })]
    expect(ids(findCandidates(inspection({ partId: 'BOM-1', supplierId: 'S-2' }), steps))).toEqual(['b'])
    // 报检不带外协厂时不过滤
    expect(ids(findCandidates(inspection({ partId: 'BOM-1' }), steps))).toEqual(['a', 'b', 'c'])
  })

  it('只认同一工单、在外加工/加工中的外协步骤', () => {
    const steps = [
      step('other-wo', { part: { workOrderNumber: 'WO-2' } }),
      step('pending', { status: 'PENDING' }),
      step('done', { status: 'DONE' }),
      step('self', { mode: 'SELF', status: 'IN_PROGRESS' }),
      step('in-plant', { mode: 'IN_PLANT_OUTSOURCE', status: 'IN_PROGRESS' }),
    ]
    expect(ids(findCandidates(inspection({ partId: 'BOM-1' }), steps))).toEqual(['in-plant'])
  })

  it('零个候选', () => {
    expect(findCandidates(inspection({ partName: '不存在的件' }), [step('a')])).toEqual([])
    expect(findCandidates(inspection(), [])).toEqual([])
  })

  it('多个候选（同一物料两道外协同时在外）', () => {
    const steps = [step('a'), step('b', { processId: 'P-PAINT', processName: '涂装', supplierId: 'S-3' })]
    expect(ids(findCandidates(inspection({ partId: 'BOM-1' }), steps))).toEqual(['a', 'b'])
  })
})
