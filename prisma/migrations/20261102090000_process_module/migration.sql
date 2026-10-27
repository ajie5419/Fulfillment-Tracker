-- 工艺模块（10-27，zhao 定）：设计任务（按部件）加料单状态、工艺状态；新建状态变更记录表。只加列和新表，不改已有数据（老任务默认 料单=未开始、工艺=无）。
-- AlterTable
ALTER TABLE `drawing_task` ADD COLUMN `materialAt` DATETIME(3) NULL,
    ADD COLUMN `materialBy` VARCHAR(64) NULL,
    ADD COLUMN `materialStatus` ENUM('NOT_STARTED', 'DRAFTING', 'REVISING', 'ISSUED') NOT NULL DEFAULT 'NOT_STARTED',
    ADD COLUMN `processAt` DATETIME(3) NULL,
    ADD COLUMN `processBy` VARCHAR(64) NULL,
    ADD COLUMN `processStatus` ENUM('NONE', 'DRAFTING', 'ISSUED') NOT NULL DEFAULT 'NONE';

-- CreateTable
CREATE TABLE `process_doc_log` (
    `id` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `kind` ENUM('MATERIAL', 'PROCESS') NOT NULL,
    `fromStatus` VARCHAR(32) NOT NULL,
    `toStatus` VARCHAR(32) NOT NULL,
    `note` VARCHAR(500) NULL,
    `releaseId` VARCHAR(64) NULL,
    `actorId` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `process_doc_log_taskId_createdAt_idx`(`taskId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `drawing_task_materialStatus_idx` ON `drawing_task`(`materialStatus`);

-- AddForeignKey
ALTER TABLE `process_doc_log` ADD CONSTRAINT `process_doc_log_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `drawing_task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

