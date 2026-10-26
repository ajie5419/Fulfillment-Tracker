-- 留言（工件 / 采购行，可 @人）。只新建表
-- CreateTable
CREATE TABLE `comment` (
    `id` VARCHAR(191) NOT NULL,
    `refType` VARCHAR(20) NOT NULL,
    `refId` VARCHAR(64) NOT NULL,
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `authorId` VARCHAR(64) NOT NULL,
    `body` TEXT NOT NULL,
    `mentionIds` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `comment_refType_refId_idx`(`refType`, `refId`),
    INDEX `comment_workOrderNumber_idx`(`workOrderNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

