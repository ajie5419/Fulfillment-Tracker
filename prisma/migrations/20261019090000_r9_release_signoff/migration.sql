-- R9 发放签收 + 设计变更：发放单、签收记录；W5 发放未签收预警；工序"等变更"标记；发放单附件；提醒跳转地址

-- 预警规则加 W5（发放未签收）
ALTER TABLE `alert` MODIFY `rule` ENUM('W1', 'W2', 'W3', 'W4', 'W5') NOT NULL;
ALTER TABLE `threshold` MODIFY `rule` ENUM('W1', 'W2', 'W3', 'W4', 'W5') NOT NULL;

-- 拒收通知等 kind = RELEASE 的提醒带跳转地址
ALTER TABLE `reminder` ADD COLUMN `link` VARCHAR(191) NULL;

-- 等变更：设计变更发放时还没开工的工序打上，变更影响确认后清空
ALTER TABLE `route_step` ADD COLUMN `holdReleaseId` VARCHAR(64) NULL,
    ADD COLUMN `holdClearedAt` DATETIME(3) NULL;
CREATE INDEX `route_step_holdReleaseId_idx` ON `route_step`(`holdReleaseId`);

-- 发放单附件（PDF / 照片）
ALTER TABLE `upload_file` ADD COLUMN `releaseId` VARCHAR(64) NULL;
CREATE INDEX `upload_file_releaseId_idx` ON `upload_file`(`releaseId`);

-- CreateTable
CREATE TABLE `doc_release` (
    `id` VARCHAR(191) NOT NULL,
    `releaseNo` VARCHAR(32) NOT NULL,
    `type` ENUM('DRAWING', 'CHANGE', 'PROCESS') NOT NULL,
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `partIds` JSON NULL,
    `version` VARCHAR(64) NULL,
    `description` TEXT NOT NULL,
    `issuerId` VARCHAR(64) NOT NULL,
    `status` ENUM('ACTIVE', 'VOID') NOT NULL DEFAULT 'ACTIVE',
    `changeConfirmedAt` DATETIME(3) NULL,
    `changeConfirmedBy` VARCHAR(64) NULL,
    `changeConfirmNote` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `doc_release_releaseNo_key`(`releaseNo`),
    INDEX `doc_release_workOrderNumber_createdAt_idx`(`workOrderNumber`, `createdAt`),
    INDEX `doc_release_issuerId_idx`(`issuerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `release_receipt` (
    `id` VARCHAR(191) NOT NULL,
    `releaseId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(64) NOT NULL,
    `status` ENUM('PENDING', 'SIGNED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `reason` VARCHAR(500) NULL,
    `actedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `release_receipt_userId_status_idx`(`userId`, `status`),
    INDEX `release_receipt_status_idx`(`status`),
    UNIQUE INDEX `release_receipt_releaseId_userId_key`(`releaseId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `release_receipt` ADD CONSTRAINT `release_receipt_releaseId_fkey` FOREIGN KEY (`releaseId`) REFERENCES `doc_release`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- W5 默认阈值：发放 4 小时未签收提醒，1 天黄，2 天红（已有的不覆盖）
INSERT IGNORE INTO `threshold` (`rule`, `remindHours`, `yellowDays`, `redDays`) VALUES ('W5', 4, 1, 2);
