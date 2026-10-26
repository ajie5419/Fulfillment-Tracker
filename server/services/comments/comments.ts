/**
 * 留言（借鉴 ERPNext 记录上的评论，10-26）：挂在工件、采购行上，能 @人；被 @ 的人收到一条提醒（kind = COMMENT），点开跳回这条记录。
 * 只新增，不改不删（和流转记录一样留痕）。谁能看到这个工单，谁就能看和写留言（接口层按工单可见范围拦）。
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { FlowError } from '../flow/errors'
import { loadNames } from '../flow/names'

type Tx = Prisma.TransactionClient

export const COMMENT_REFS = ['part', 'purchase'] as const
export type CommentRef = (typeof COMMENT_REFS)[number]

export const MAX_COMMENT = 1000
const MAX_MENTIONS = 10

/** 留言挂的对象：所属工单、给人看的名字、电脑端跳转地址（带 comments=1 自动打开留言） */
export async function resolveRef(db: Tx | typeof prisma, refType: CommentRef, refId: string) {
  if (refType === 'part') {
    const p = await db.part.findUnique({ where: { id: refId }, select: { workOrderNumber: true, name: true } })
    if (!p) return null
    return { workOrderNumber: p.workOrderNumber, title: `工件"${p.name}"`, link: `/parts?wo=${encodeURIComponent(p.workOrderNumber)}&part=${encodeURIComponent(refId)}&comments=1` }
  }
  const l = await db.purchaseLine.findUnique({ where: { id: refId }, select: { workOrderNumber: true, materialName: true } })
  if (!l) return null
  return { workOrderNumber: l.workOrderNumber, title: `采购"${l.materialName}"`, link: `/purchases?wo=${encodeURIComponent(l.workOrderNumber)}&id=${encodeURIComponent(refId)}&comments=1` }
}

const ids = (v: Prisma.JsonValue | null): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export async function listComments(refType: CommentRef, refId: string) {
  const rows = await prisma.comment.findMany({ where: { refType, refId }, orderBy: { createdAt: 'asc' } })
  const names = await loadNames({ user: rows.flatMap((r) => [r.authorId, ...ids(r.mentionIds)]) })
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    createdAt: r.createdAt,
    authorId: r.authorId,
    authorName: names.user.get(r.authorId) ?? r.authorId,
    mentions: ids(r.mentionIds).map((id) => ({ id, name: names.user.get(id) ?? id })),
  }))
}

/** 各对象的留言条数（列表上显示"留言 N"） */
export async function countComments(refType: CommentRef, refIds: string[]) {
  if (!refIds.length) return new Map<string, number>()
  const rows = await prisma.comment.groupBy({ by: ['refId'], where: { refType, refId: { in: refIds } }, _count: { _all: true } })
  return new Map(rows.map((r) => [r.refId, r._count._all]))
}

export interface CommentInput {
  refType: CommentRef
  refId: string
  body: string
  mentionIds?: string[]
}

export async function addComment(input: CommentInput, authorId: string) {
  const body = input.body.trim()
  if (!body) throw new FlowError('请填写留言内容')
  if (body.length > MAX_COMMENT) throw new FlowError(`留言最多 ${MAX_COMMENT} 字`)
  const mentionIds = [...new Set(input.mentionIds ?? [])].filter((id) => id !== authorId)
  if (mentionIds.length > MAX_MENTIONS) throw new FlowError(`一次最多 @ ${MAX_MENTIONS} 个人`)
  return prisma.$transaction(async (tx) => {
    const ref = await resolveRef(tx, input.refType, input.refId)
    if (!ref) throw new FlowError('留言的对象不存在或已删除')
    if (mentionIds.length) {
      const found = await tx.qmsUser.count({ where: { id: { in: mentionIds }, isDeleted: false } })
      if (found !== mentionIds.length) throw new FlowError('@ 的人不存在或已停用')
    }
    const comment = await tx.comment.create({
      data: { refType: input.refType, refId: input.refId, workOrderNumber: ref.workOrderNumber, authorId, body, mentionIds: mentionIds.length ? mentionIds : undefined },
    })
    if (mentionIds.length) {
      const author = (await loadNames({ user: [authorId] })).user.get(authorId) ?? authorId
      const brief = body.length > 40 ? `${body.slice(0, 40)}…` : body
      const title = `【留言】${author} 在${ref.title}提到你：${brief}（${ref.workOrderNumber}）`
      await tx.reminder.createMany({
        data: mentionIds.map((userId) => ({
          userId,
          kind: 'COMMENT',
          level: 'REMIND' as const,
          title: title.length > 190 ? `${title.slice(0, 189)}…` : title,
          link: ref.link,
          dedupeKey: `COMMENT:${comment.id}:${userId}`,
        })),
        skipDuplicates: true,
      })
    }
    return comment
  })
}
