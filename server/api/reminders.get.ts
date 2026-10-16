/** 我的提醒：未读在前。R4 起由 scan-rules 写入，R1 只有空列表。 */
export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  const items = await prisma.reminder.findMany({
    where: { userId: user.qmsUserId },
    orderBy: [{ readAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
    take: 100,
    select: { id: true, title: true, level: true, readAt: true, createdAt: true },
  })
  return { items, unread: items.filter((i) => !i.readAt).length }
})
