import { describe, expect, it } from 'vitest'
import { inspectArchitecture } from '../../scripts/architecture-rules.mjs'

describe('architectural regression barriers', () => {
  it('requires JSON boundaries and limits raw downloads to the declared routes', () => {
    expect(inspectArchitecture('server/api/example.get.ts', 'export default defineEventHandler(() => [])')).toEqual([expect.stringContaining('api-response-contract')])
    expect(inspectArchitecture('server/api/example.get.ts', 'export default defineFileHandler(() => [])')).toHaveLength(1)
    expect(inspectArchitecture('server/api/example.get.ts', 'export default defineApiHandler(() => [])')).toEqual([])
    expect(inspectArchitecture('server/api/files/[id].get.ts', 'export default defineFileHandler(() => bytes)')).toEqual([])
  })
  it('rejects bypassing the decoder but leaves logout and transport boundaries available', () => {
    for (const code of ["$fetch('/api/me')", "useFetch('/api/me')", 'useRequestFetch()', "fetch('/api/me')"]) {
      expect(inspectArchitecture('app/pages/example.vue', `<script setup>${code}</script>`)).toEqual([expect.stringContaining('api-response-contract')])
    }
    expect(inspectArchitecture('app/page.ts', "apiFetch('/api/me'); useApiFetch('/api/me'); $fetch('/auth/logout', { method: 'POST' })")).toEqual([])
    expect(inspectArchitecture('app/composables/useApiFetch.ts', 'useFetch(request)')).toEqual([])
  })
  it('rejects runtime server dependencies but permits type-only contracts', () => {
    for (const code of ["import { run } from '../../server/service'", "export { run } from '../../server/service'", "const x = import('../../server/service')", "import {} from '../../server/service'", "export {} from '../../server/service'"]) {
      expect(inspectArchitecture('app/client.ts', code)).toEqual([expect.stringContaining('client-server-boundary')])
    }
    expect(inspectArchitecture('app/client.ts', "import type { Row } from '../../server/service'; type R = typeof import('../../server/service')")).toEqual([])
    expect(inspectArchitecture('app/client.ts', "import { type Row } from '../../server/service'")).toEqual([])
    for (const code of ["import service = require('../../server')", "import '#server/service'", "const x = require('../../server')"]) {
      expect(inspectArchitecture('app/client.ts', code)).toEqual([expect.stringContaining('client-server-boundary')])
    }
    expect(inspectArchitecture('app/client.ts', "import type Service = require('../../server')")).toEqual([])
  })
  it('rejects reintroduced handwritten response models while allowing derived types', () => {
    expect(inspectArchitecture('app/model.ts', 'interface DrawingRow { id: string }')).toHaveLength(1)
    expect(inspectArchitecture('app/model.ts', "type DrawingRow = ClientResponse<'/api/drawings', 'GET'>['rows'][number]")).toEqual([])
  })
  it('blocks display-name routing and authorization without banning UI text', () => {
    expect(inspectArchitecture('server/services/process/eligibility.ts', "const where = { name: { contains: '采购计划' } }")).toHaveLength(1)
    expect(inspectArchitecture('server/services/auth/permissions.ts', 'const ok = keys.includes(BUSINESS_DEPT_NAME.TECH)')).toHaveLength(1)
    expect(inspectArchitecture('app/label.ts', 'const text = BUSINESS_DEPT_NAME.TECH')).toEqual([])
    for (const code of ["const { name: label } = node", "const { name } = node", "const label = node['name']"]) {
      expect(inspectArchitecture('server/services/process/eligibility.ts', code)).toHaveLength(1)
    }
    expect(inspectArchitecture('server/services/process/eligibility.ts', 'const reason = error.name')).toEqual([])
  })
  it('blocks copied quantity rules and upload text, including Vue templates', () => {
    expect(inspectArchitecture('server/schemas/purchases.ts', 'const limit = 1_000_000_000')).toHaveLength(1)
    expect(inspectArchitecture('app/components/PurchaseEditModal.vue', '<template><input :precision="3" /></template>')).toHaveLength(1)
    expect(inspectArchitecture('app/components/PurchaseEditModal.vue', '<template><input :max="1000000000" /></template>')).toHaveLength(1)
    expect(inspectArchitecture('app/components/ReleaseCreateModal.vue', '<template><p>附件最多 20MB</p></template>')).toHaveLength(1)
    expect(inspectArchitecture('server/services/issues/uploads.ts', "// formerly 20MB\nconst text = `不能超过 ${formatUploadLimit(MAX_ATTACHMENT_BYTES)}`")).toEqual([])
  })
})
