export default defineApiHandler(async () => {
  await prisma.$queryRaw`SELECT 1`
  return { ok: true }
})
