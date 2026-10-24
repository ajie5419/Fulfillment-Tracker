/**
 * 异常照片、发放单附件的上传与读取。
 *
 * - 照片只收 JPEG / PNG / WebP；发放单附件（kind = attachment）另收 PDF；图纸发放单的 BOM 表（kind = bom）只收 .xlsx。
 *   按文件头魔数判断，不信扩展名和浏览器给的 Content-Type；照片每张 ≤ 8MB，附件每个 ≤ 20MB，BOM ≤ 5MB。
 * - 存到 runtimeConfig.uploadDir（NUXT_UPLOAD_DIR，默认 ./data/uploads），文件名是随机 id + 按类型定的扩展名，
 *   不用用户给的文件名；读取时只用库里的 storedName 拼路径，并校验仍在上传目录内（防路径穿越）。
 * - 上报异常时把照片绑定到该异常（upload_file.issueId），建发放单时把附件绑定到发放单（releaseId）；未绑定的只有上传人自己能读。
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { prisma } from '../../utils/prisma'
import { FlowError } from '../flow/errors'
import { isReleaseParty } from '../releases/releases'
import { XLSX_MIME } from '../bom/excel'

export { XLSX_MIME }

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
/** 发放单附件（图纸 PDF 可能较大）每个的上限 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** 一次请求最多几个文件（上报异常最多 3 张照片；附件分批传） */
export const MAX_FILES_PER_REQUEST = 3

/** BOM 表（CAD 导出的 Excel）的上限 */
export const MAX_BOM_BYTES = 5 * 1024 * 1024

/** photo = 异常照片（只收图片）；attachment = 发放单附件（图片或 PDF）；bom = 图纸发放单的 BOM 表（只收 .xlsx） */
export type UploadKind = 'photo' | 'attachment' | 'bom'
export const MAX_BYTES: Record<UploadKind, number> = { photo: MAX_UPLOAD_BYTES, attachment: MAX_ATTACHMENT_BYTES, bom: MAX_BOM_BYTES }

const TYPES = [
  { mime: 'image/jpeg', ext: 'jpg', test: (b: Buffer) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: (b: Buffer) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b: Buffer) => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
] as const

/** 按文件头魔数识别图片类型；不是 JPEG/PNG/WebP 返回 null */
export function sniffImage(buf: Buffer): { mime: string; ext: string } | null {
  const t = TYPES.find((x) => x.test(buf))
  return t ? { mime: t.mime, ext: t.ext } : null
}

/** PDF：文件头 "%PDF-" */
export function sniffPdf(buf: Buffer): { mime: string; ext: string } | null {
  return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-' ? { mime: 'application/pdf', ext: 'pdf' } : null
}

/** .xlsx 是 zip：文件头 PK\x03\x04（真正能不能读由 readBomWorkbook 再验） */
export function sniffXlsx(buf: Buffer): { mime: string; ext: string } | null {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04 ? { mime: XLSX_MIME, ext: 'xlsx' } : null
}

const SNIFF: Record<UploadKind, (b: Buffer) => { mime: string; ext: string } | null> = {
  photo: sniffImage,
  attachment: (b) => sniffImage(b) ?? sniffPdf(b),
  bom: sniffXlsx,
}
const TYPE_DENIED: Record<UploadKind, string> = {
  photo: '只能上传 JPG、PNG 或 WebP 格式的图片',
  attachment: '附件只能是 PDF，或 JPG、PNG、WebP 格式的图片',
  bom: 'BOM 只能是 .xlsx 文件（.xls 请先用 Excel 另存为 .xlsx）',
}
const TOO_LARGE: Record<UploadKind, string> = { photo: '照片不能超过 8MB', attachment: '附件不能超过 20MB', bom: 'BOM 表不能超过 5MB' }

const ID_RE = /^[a-f0-9]{32}$/

/** 校验并保存一个文件（照片、发放单附件或 BOM 表），返回 upload_file 记录 */
export async function saveUpload(dir: string, data: Buffer, uploaderId: string, kind: UploadKind = 'photo') {
  if (!data.length) throw new FlowError('文件是空的')
  if (data.length > MAX_BYTES[kind]) throw new FlowError(TOO_LARGE[kind])
  const type = SNIFF[kind](data)
  if (!type) throw new FlowError(TYPE_DENIED[kind])
  const id = randomBytes(16).toString('hex')
  const storedName = `${id}.${type.ext}`
  const root = resolve(dir)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, storedName), data, { flag: 'wx' })
  try {
    return await prisma.uploadFile.create({ data: { id, storedName, mime: type.mime, size: data.length, uploaderId } })
  } catch (err) {
    await rm(join(root, storedName), { force: true })
    throw err
  }
}

/** 只用库里的文件名拼路径，并确认仍在上传目录内 */
function safePath(dir: string, storedName: string) {
  const root = resolve(dir)
  const full = resolve(root, basename(storedName))
  if (!full.startsWith(root + sep)) throw new FlowError('文件不存在')
  return full
}

/**
 * 读取前查记录。canSeeWorkOrder 由接口层传入（canSee 的唯一入口在 server/utils/auth.ts）：
 * 已绑定异常的按异常所属工单判断；已绑定发放单的按发放单所属工单判断，发放单的接收人也能读；
 * 未绑定的只有上传人自己能读。不满足一律当"不存在"，不暴露文件是否存在。
 */
export async function readUpload(dir: string, id: string, userId: string, canSeeWorkOrder: (wo: string) => boolean) {
  if (!ID_RE.test(id)) return null
  const file = await prisma.uploadFile.findUnique({ where: { id } })
  if (!file) return null
  if (file.issueId) {
    const issue = await prisma.issue.findUnique({ where: { id: file.issueId }, select: { workOrderNumber: true } })
    if (!issue || !canSeeWorkOrder(issue.workOrderNumber)) return null
  } else if (file.releaseId) {
    const release = await prisma.release.findUnique({ where: { id: file.releaseId }, select: { workOrderNumber: true } })
    if (!release || !(canSeeWorkOrder(release.workOrderNumber) || (await isReleaseParty(file.releaseId, userId)))) return null
  } else if (file.uploaderId !== userId) {
    return null
  }
  try {
    return { file, data: await readFile(safePath(dir, file.storedName)) }
  } catch {
    return null
  }
}

/** 读自己刚上传、还没绑定的文件（发放单附 BOM 表时先读出内容再建单）；不满足返回 null */
export async function readOwnUnbound(dir: string, id: string, uploaderId: string, mime: string) {
  if (!ID_RE.test(id)) return null
  const file = await prisma.uploadFile.findFirst({ where: { id, uploaderId, mime, issueId: null, releaseId: null } })
  if (!file) return null
  try {
    return await readFile(safePath(dir, file.storedName))
  } catch {
    return null
  }
}

/** 清理演示数据时删文件（尽力而为，文件不在也不报错） */
export async function removeUploadFiles(dir: string, storedNames: string[]) {
  for (const name of storedNames) await rm(safePath(dir, name), { force: true }).catch(() => {})
}
