-- 仅本地开发用。生产账号只授予 fulfillment 库权限（见 README）。
-- 允许本地账号使用测试库，并创建 Prisma migrate dev 需要的影子库。
CREATE DATABASE IF NOT EXISTS fulfillment_test;
GRANT ALL PRIVILEGES ON `fulfillment_test`.* TO 'fulfillment'@'%';
GRANT ALL PRIVILEGES ON `prisma_migrate_shadow_db_%`.* TO 'fulfillment'@'%';
FLUSH PRIVILEGES;
