import { describe, expect, it } from 'vitest'
import { BUSINESS_DEPT_NAME, departmentLabel } from '../../shared/business-depts'
import { NOTIFY_ROLE_TEXT } from '../../shared/notify-roles'
import { deptIdsResolvingTo, resolveBusinessDept, resolveDeptIdentity, resolveDeptName, type DeptIndex } from '../../server/services/auth/departments'
import { inDept, isDeptHead, type RoleContext } from '../../server/services/auth/permissions'
import { recipientsFor } from '../../server/services/alerts/notifications'
import { groupLabel, resolveGroup, ROLE_TEXT } from '../../server/services/releases/constants'
import { deptRows } from '../../server/services/alerts/settings'

const roles = [{ id: 'head-role', role: 'DEPT_HEAD' as const, userId: 'head', department: 'TECH' }]
const context: RoleContext = { userId: 'head', isAdmin: false, roles: ['DEPT_HEAD'], deptHeadOf: ['TECH'], businessDept: null, pmOf: new Set() }
const index: DeptIndex = {
  depts: new Map([['mapped', { name: '外部研发中心', parentId: null }], ['legacy', { name: '历史工程组', parentId: null }]]),
  mapping: new Map([['mapped', 'TECH']]),
}

describe('stable department identity', () => {
  it('keeps permissions, department scope and notifications stable after a display rename', () => {
    const labels = BUSINESS_DEPT_NAME as Record<string, string>
    const original = labels.TECH!
    labels.TECH = '研发中心'
    try {
      expect(resolveBusinessDept('mapped', index)).toBe('TECH')
      expect(resolveDeptName('mapped', index)).toBe('研发中心')
      expect(deptRows([{ id: 'unmapped', name: '技术部', parentId: '0' }], new Map())[0]?.effective).toBe('研发中心')
      expect(deptIdsResolvingTo('TECH', index)).toEqual(['mapped'])
      expect(inDept(context, 'TECH')).toBe(true)
      expect(isDeptHead(context, 'TECH')).toBe(true)
      expect(recipientsFor('YELLOW', { ownerIds: [], workOrderNumber: null, departmentKeys: ['TECH'] }, { roles, deptOf: new Map(), pmOf: new Map() })).toEqual(['head'])
      expect(resolveGroup({ department: 'TECH', role: 'DEPT_HEAD' }, { users: [{ id: 'head', deptName: '外部研发中心', departmentKey: 'TECH' }], roles })).toEqual(['head'])
      expect(groupLabel({ department: 'TECH', role: 'DEPT_HEAD' })).toBe('研发中心 · 部门负责人')
    } finally {
      labels.TECH = original
    }
  })

  it('preserves an unknown historical department for explicit remediation without granting a business identity', () => {
    expect(resolveDeptIdentity('legacy', index)).toBe('历史工程组')
    expect(resolveBusinessDept('legacy', index)).toBeNull()
    expect(departmentLabel('历史工程组')).toBe('历史工程组')
    expect(deptIdsResolvingTo('历史工程组', index)).toEqual(['legacy'])
    expect(inDept({ ...context, deptHeadOf: ['历史工程组'] }, 'TECH')).toBe(false)
    expect(recipientsFor('YELLOW', { ownerIds: [], workOrderNumber: null, departmentKeys: ['历史工程组'] }, { roles: [{ ...roles[0]!, department: '历史工程组' }], deptOf: new Map(), pmOf: new Map() })).toEqual(['head'])
  })

  it('shares role labels instead of maintaining a server copy', () => {
    expect(ROLE_TEXT).toBe(NOTIFY_ROLE_TEXT)
  })
})
