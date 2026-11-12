import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadAttachments } from '../../app/composables/useReleases'
import { uploadPhotos } from '../../app/composables/useIssues'

const policy = vi.hoisted(() => ({ maxFilesPerRequest: 2 }))
vi.mock('#shared/upload-policy', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../shared/upload-policy')>(),
  get MAX_FILES_PER_REQUEST() { return policy.maxFilesPerRequest },
}))

afterEach(() => vi.unstubAllGlobals())

describe.each([
  { name: 'release attachments', upload: uploadAttachments, url: '/api/uploads?kind=attachment', extension: 'pdf', count: 5, batches: { 1: [1, 1, 1, 1, 1], 2: [2, 2, 1], 4: [4, 1] } },
  { name: 'issue photos', upload: uploadPhotos, url: '/api/uploads', extension: 'jpg', count: 3, batches: { 1: [1, 1, 1], 2: [2, 1], 4: [3] } },
])('$name follow the configured request limit', ({ upload, url, extension, count, batches }) => {
  it.each([1, 2, 4] as const)('uploads every file in order when the limit is %s', async (limit) => {
    policy.maxFilesPerRequest = limit
    const files = Array.from({ length: count }, (_, index) => new File(['test'], `file-${index}.${extension}`))
    const received: string[][] = []
    const request = vi.fn(async (requestUrl: string, options: { method: string; body: FormData }) => {
      expect(requestUrl).toBe(url)
      expect(options.method).toBe('POST')
      const batch = options.body.getAll('file') as File[]
      if (batch.length > limit) throw new Error('Request exceeds the configured upload limit')
      received.push(batch.map(file => file.name))
      return batch.map(file => ({ id: `saved-${file.name}` }))
    })
    vi.stubGlobal('clientRequest', request)

    expect(await upload(files)).toEqual(files.map(file => `saved-${file.name}`))
    expect(received.map(batch => batch.length)).toEqual(batches[limit])
    expect(received.flat()).toEqual(files.map(file => file.name))
  })

  it('does not send a request when there are no files', async () => {
    const request = vi.fn()
    vi.stubGlobal('clientRequest', request)
    expect(await upload([])).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })
})
