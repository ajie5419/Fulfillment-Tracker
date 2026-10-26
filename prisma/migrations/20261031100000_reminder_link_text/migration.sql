-- 提醒跳转地址放宽到 TEXT：工单号 URL 编码后（中文一个字 9 位）很快超过 191，留言、发放提醒会写入失败
-- AlterTable
ALTER TABLE `reminder` MODIFY `link` TEXT NULL;

