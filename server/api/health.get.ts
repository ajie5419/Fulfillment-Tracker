export default defineEventHandler(async () => {
  await prisma.$queryRaw`SELECT 1`
  return { ok: true }
})
