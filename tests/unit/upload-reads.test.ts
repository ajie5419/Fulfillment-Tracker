import { logEvent } from '../../server/observability/logger'
vi.mock('../../server/observability/logger', () => ({ logEvent: vi.fn() }))
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns } from '../helpers/service-db'

vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
vi.mock('../../server/services/releases/releases', () => ({ isReleaseParty: vi.fn() }))
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), readFile: vi.fn() }))

import { isReleaseParty } from '../../server/services/releases/releases'
import { FlowHttpError } from '../../server/services/flow/errors'
import { readOwnUnbound, readUpload } from '../../server/services/issues/uploads'

const file = { id: 'a'.repeat(32), storedName: `${'a'.repeat(32)}.jpg`, mime: 'image/jpeg', uploaderId: 'owner', issueId: null, releaseId: null }
let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'ft-upload-reads-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })
beforeEach(async () => {
  resetServiceDb()
  returns('uploadFile.findUnique', file)
  returns('uploadFile.findFirst', file)
  vi.mocked(readFile).mockReset().mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readFile)
  vi.mocked(isReleaseParty).mockReset().mockResolvedValue(false)
  vi.mocked(logEvent).mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe.each([
  { name: 'readUpload', read: (id = file.id) => readUpload(dir, id, 'owner', () => true), query: 'uploadFile.findUnique' },
  { name: 'readOwnUnbound', read: (id = file.id) => readOwnUnbound(dir, id, 'owner', file.mime), query: 'uploadFile.findFirst' },
])('$name 读取故障分类', ({ name, read, query }) => {
  it('文件在磁盘上确实不存在时仍返回 null，不记录故障', async () => {
    await expect(read()).resolves.toBeNull()
    expect(readFile).toHaveBeenCalledWith(join(dir, file.storedName))
    expect(logEvent).not.toHaveBeenCalled()
  })

  it.each([
    Object.assign(new Error('EACCES: internal disk path'), { code: 'EACCES' }),
    new Error('internal disk failure'),
  ])('非 ENOENT 故障抛通用错误并记录关联信息：%s', async failure => {
    vi.mocked(readFile).mockRejectedValueOnce(failure)
    const result = read()
    await expect(result).rejects.toBeInstanceOf(FlowHttpError)
    await expect(result).rejects.toMatchObject({ message: '文件读取失败，请稍后重试', statusCode: 500 })
    expect(logEvent).toHaveBeenCalledExactlyOnceWith('error', 'upload.read.failed', { entityId: file.id }, failure)
  })

  it('成功时保持原有返回结构', async () => {
    const data = Buffer.from('file contents')
    vi.mocked(readFile).mockResolvedValueOnce(data)
    await expect(read()).resolves.toEqual(name === 'readUpload' ? { file, data } : data)
    expect(logEvent).not.toHaveBeenCalled()
  })

  it('无效 ID 不查询记录、不读取磁盘', async () => {
    await expect(read('../../etc/passwd')).resolves.toBeNull()
    expect(method(query)).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    expect(logEvent).not.toHaveBeenCalled()
  })

  it('查不到可读记录时不读取磁盘，也不记录读取故障', async () => {
    returns(query, null)
    await expect(read()).resolves.toBeNull()
    expect(readFile).not.toHaveBeenCalled()
    expect(logEvent).not.toHaveBeenCalled()
    if (name === 'readOwnUnbound') {
      expect(method(query)).toHaveBeenCalledWith({ where: { id: file.id, uploaderId: 'owner', mime: file.mime, issueId: null, releaseId: null } })
    }
  })
})

describe('readUpload 先检查权限，保持存在性隐藏', () => {
  it.each([
    { issueId: null, releaseId: null, uploaderId: 'other' },
    { issueId: 'missing-issue', releaseId: null, uploaderId: 'owner' },
    { issueId: 'hidden-issue', releaseId: null, uploaderId: 'owner' },
    { issueId: null, releaseId: 'missing-release', uploaderId: 'owner' },
    { issueId: null, releaseId: 'hidden-release', uploaderId: 'owner' },
  ])('无权或关联记录缺失仍返回 null：%o', async binding => {
    returns('uploadFile.findUnique', { ...file, ...binding })
    returns('issue.findUnique', binding.issueId === 'hidden-issue' ? { workOrderNumber: 'hidden' } : null)
    returns('release.findUnique', binding.releaseId === 'hidden-release' ? { workOrderNumber: 'hidden' } : null)
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    await expect(readUpload(dir, file.id, 'owner', () => false)).resolves.toBeNull()
    expect(readFile).not.toHaveBeenCalled()
    expect(logEvent).not.toHaveBeenCalled()
  })

  it('发放单接收人仍可读取可见范围外的附件', async () => {
    const attachment = { ...file, releaseId: 'release' }
    const data = Buffer.from('attachment')
    returns('uploadFile.findUnique', attachment)
    returns('release.findUnique', { workOrderNumber: 'hidden' })
    vi.mocked(isReleaseParty).mockResolvedValueOnce(true)
    vi.mocked(readFile).mockResolvedValueOnce(data)
    await expect(readUpload(dir, file.id, 'receiver', () => false)).resolves.toEqual({ file: attachment, data })
    expect(isReleaseParty).toHaveBeenCalledWith('release', 'receiver')
  })
})
