-- R11 设计出图任务：出图任务（按部件拆，可关联多个工件）、发放单关联出图任务、W7 出图逾期预警

-- AlterTable
ALTER TABLE `alert` MODIFY `rule` ENUM('W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7') NOT NULL;

-- AlterTable
ALTER TABLE `threshold` MODIFY `rule` ENUM('W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7') NOT NULL;

-- AlterTable
ALTER TABLE `doc_release` ADD COLUMN `drawingTaskId` VARCHAR(64) NULL;

-- CreateTable
CREATE TABLE `drawing_task` (
    `id` VARCHAR(191) NOT NULL,
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `componentName` VARCHAR(191) NOT NULL,
    `ownerId` VARCHAR(64) NULL,
    `planDate` DATETIME(3) NOT NULL,
    `drawnDate` DATETIME(3) NULL,
    `drawnBy` VARCHAR(64) NULL,
    `needsCustomerConfirm` BOOLEAN NOT NULL DEFAULT false,
    `customerPlanDate` DATETIME(3) NULL,
    `customerConfirmedDate` DATETIME(3) NULL,
    `customerConfirmedBy` VARCHAR(64) NULL,
    `status` ENUM('PENDING', 'DRAWN', 'CUSTOMER_PENDING', 'DONE', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `note` VARCHAR(500) NULL,
    `createdBy` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `drawing_task_workOrderNumber_status_idx`(`workOrderNumber`, `status`),
    INDEX `drawing_task_ownerId_status_idx`(`ownerId`, `status`),
    INDEX `drawing_task_status_planDate_idx`(`status`, `planDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `drawing_task_part` (
    `taskId` VARCHAR(191) NOT NULL,
    `partId` VARCHAR(191) NOT NULL,

    INDEX `drawing_task_part_partId_idx`(`partId`),
    PRIMARY KEY (`taskId`, `partId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `doc_release_drawingTaskId_idx` ON `doc_release`(`drawingTaskId`);

-- AddForeignKey
ALTER TABLE `drawing_task_part` ADD CONSTRAINT `drawing_task_part_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `drawing_task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `drawing_task_part` ADD CONSTRAINT `drawing_task_part_partId_fkey` FOREIGN KEY (`partId`) REFERENCES `part`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- W7 默认阈值：计划完成日前 2 天（48 小时）仍未出图 → 黄（已过计划完成日 → 红）；客户确认超计划日 1 天黄、4 天红（已有的不覆盖）
INSERT IGNORE INTO `threshold` (`rule`, `remindHours`, `yellowDays`, `redDays`) VALUES ('W7', 48, 1, 4);
