import { describe, expect, it } from 'vitest'
import { qmsWorkOrderSchema } from '../../server/services/sync/resources'

const row = { workOrderNumber: 'WO-1', deliveryDate: '2027-01-08T00:00:00.000Z', status: 'OPEN', updatedAt: '2026-11-09T00:00:00.000Z' }

describe('contract effective date synchronization', () => {
  it('parses the source date without substituting delivery or creation dates', () => {
    const result = qmsWorkOrderSchema.parse({ ...row, effectiveTime: '2026-10-01T00:00:00.000Z' })
    expect(result.effectiveTime).toEqual(new Date('2026-10-01T00:00:00.000Z'))
  })
  it('preserves omitted fields from older sources and explicit null separately', () => {
    expect(qmsWorkOrderSchema.parse(row)).not.toHaveProperty('effectiveTime')
    expect(qmsWorkOrderSchema.parse({ ...row, effectiveTime: null }).effectiveTime).toBeNull()
  })
})
