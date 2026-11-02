-- 增量加表，不修改既有工单或扩展表。
CREATE TABLE `work_order_local_save` (
    `operationId` VARCHAR(128) NOT NULL,
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `operation` VARCHAR(20) NOT NULL,
    `actorId` VARCHAR(64) NOT NULL,
    `extPayload` JSON NOT NULL,
    `requestPayload` JSON NOT NULL,
    `remoteResult` JSON NULL,
    `remoteError` JSON NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `pendingWorkOrder` VARCHAR(64) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,
    UNIQUE INDEX `work_order_local_save_pendingWorkOrder_key` (`pendingWorkOrder`),
    INDEX `work_order_local_save_workOrderNumber_createdAt_idx` (`workOrderNumber`, `createdAt`),
    INDEX `work_order_local_save_status_createdAt_idx` (`status`, `createdAt`),
    PRIMARY KEY (`operationId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
