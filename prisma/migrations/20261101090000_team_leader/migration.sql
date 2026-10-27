-- 班组长（生产管理重设计第二批）：班组 → 班组长。只新建表，不改 QMS 副本表；QMS 同步只 upsert qms_supplier 的契约字段，碰不到这张表
-- CreateTable
CREATE TABLE `team_leader` (
    `supplierId` VARCHAR(64) NOT NULL,
    `userId` VARCHAR(64) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedBy` VARCHAR(64) NOT NULL,

    INDEX `team_leader_userId_idx`(`userId`),
    PRIMARY KEY (`supplierId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `team_leader` ADD CONSTRAINT `team_leader_supplierId_fkey` FOREIGN KEY (`supplierId`) REFERENCES `qms_supplier`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `team_leader` ADD CONSTRAINT `team_leader_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `qms_user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

