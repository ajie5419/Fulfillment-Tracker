-- CreateTable
CREATE TABLE `qms_work_order` (
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `customerName` VARCHAR(191) NOT NULL,
    `projectName` VARCHAR(191) NULL,
    `division` VARCHAR(191) NULL,
    `quantity` INTEGER NOT NULL,
    `deliveryDate` DATETIME(3) NOT NULL,
    `status` VARCHAR(20) NOT NULL,
    `isDeleted` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `qms_work_order_status_idx`(`status`),
    PRIMARY KEY (`workOrderNumber`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `qms_supplier` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `outsourcingMode` VARCHAR(191) NULL,
    `category` VARCHAR(191) NULL,
    `isDeleted` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `qms_process` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `supplierSource` VARCHAR(20) NOT NULL,
    `responsibleDepartmentId` VARCHAR(64) NULL,
    `isDeleted` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `qms_department` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `parentId` VARCHAR(64) NOT NULL,
    `status` INTEGER NOT NULL,
    `isDeleted` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `qms_user` (
    `id` VARCHAR(64) NOT NULL,
    `username` VARCHAR(191) NOT NULL,
    `realName` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NULL,
    `department` VARCHAR(191) NOT NULL,
    `roleId` VARCHAR(64) NOT NULL,
    `roleName` VARCHAR(191) NULL,
    `status` VARCHAR(20) NOT NULL,
    `isDeleted` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `qms_inspection` (
    `id` VARCHAR(64) NOT NULL,
    `requestNo` VARCHAR(64) NOT NULL,
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `partId` VARCHAR(64) NULL,
    `partName` VARCHAR(191) NOT NULL,
    `processId` VARCHAR(64) NULL,
    `processName` VARCHAR(191) NOT NULL,
    `supplierId` VARCHAR(64) NULL,
    `supplierName` VARCHAR(191) NULL,
    `responsibilityType` VARCHAR(191) NULL,
    `quantity` INTEGER NOT NULL,
    `status` VARCHAR(20) NOT NULL,
    `inspectionResult` VARCHAR(20) NOT NULL,
    `unqualifiedQuantity` INTEGER NULL,
    `linkedIssueNo` VARCHAR(191) NULL,
    `reporterId` VARCHAR(64) NULL,
    `submittedAt` DATETIME(3) NOT NULL,
    `closedAt` DATETIME(3) NULL,
    `isDeleted` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `qms_inspection_workOrderNumber_idx`(`workOrderNumber`),
    INDEX `qms_inspection_supplierId_idx`(`supplierId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sync_cursor` (
    `resource` VARCHAR(40) NOT NULL,
    `since` DATETIME(3) NULL,
    `afterId` VARCHAR(64) NULL,
    `lastRunAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `failCount` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`resource`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `work_order_ext` (
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `projectManagerId` VARCHAR(64) NULL,
    `productLine` VARCHAR(191) NULL,
    `isPilot` BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY (`workOrderNumber`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `part` (
    `id` VARCHAR(191) NOT NULL,
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `drawingNo` VARCHAR(191) NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `qmsPartId` VARCHAR(64) NULL,
    `currentStepId` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'DONE') NOT NULL DEFAULT 'ACTIVE',
    `statusSince` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `part_workOrderNumber_idx`(`workOrderNumber`),
    INDEX `part_qmsPartId_idx`(`qmsPartId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `route_step` (
    `id` VARCHAR(191) NOT NULL,
    `partId` VARCHAR(191) NOT NULL,
    `seq` INTEGER NOT NULL,
    `processId` VARCHAR(64) NOT NULL,
    `mode` ENUM('SELF', 'IN_PLANT_OUTSOURCE', 'EXTERNAL_OUTSOURCE') NOT NULL,
    `supplierId` VARCHAR(64) NULL,
    `ownerId` VARCHAR(64) NULL,
    `dueDate` DATETIME(3) NULL,
    `promisedReturnDate` DATETIME(3) NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `status` ENUM('PENDING', 'OUT', 'IN_PROGRESS', 'DONE', 'BLOCKED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `route_step_status_idx`(`status`),
    INDEX `route_step_supplierId_idx`(`supplierId`),
    UNIQUE INDEX `route_step_partId_seq_key`(`partId`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `flow_event` (
    `id` VARCHAR(191) NOT NULL,
    `stepId` VARCHAR(191) NOT NULL,
    `type` ENUM('SEND', 'RETURN', 'RETURN_MANUAL', 'START', 'FINISH') NOT NULL,
    `qty` INTEGER NOT NULL,
    `source` ENUM('MOBILE', 'QMS_INSPECTION', 'PC') NOT NULL,
    `qmsInspectionId` VARCHAR(64) NULL,
    `actorId` VARCHAR(64) NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `flow_event_qmsInspectionId_key`(`qmsInspectionId`),
    INDEX `flow_event_stepId_idx`(`stepId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `todo` (
    `id` VARCHAR(191) NOT NULL,
    `ownerId` VARCHAR(64) NOT NULL,
    `action` VARCHAR(40) NOT NULL,
    `refType` VARCHAR(20) NOT NULL,
    `refId` VARCHAR(64) NOT NULL,
    `dueAt` DATETIME(3) NULL,
    `status` ENUM('OPEN', 'DONE', 'TRANSFERRED', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    `doneAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `todo_ownerId_status_idx`(`ownerId`, `status`),
    INDEX `todo_refType_refId_idx`(`refType`, `refId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `unmatched_inspection` (
    `qmsInspectionId` VARCHAR(64) NOT NULL,
    `reason` VARCHAR(40) NOT NULL,
    `candidates` JSON NULL,
    `status` ENUM('PENDING', 'RESOLVED', 'IGNORED') NOT NULL DEFAULT 'PENDING',
    `resolvedBy` VARCHAR(64) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `unmatched_inspection_status_idx`(`status`),
    PRIMARY KEY (`qmsInspectionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `issue` (
    `id` VARCHAR(191) NOT NULL,
    `issueNo` VARCHAR(32) NOT NULL,
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `refType` VARCHAR(20) NULL,
    `refId` VARCHAR(64) NULL,
    `category` ENUM('DESIGN', 'CHANGE', 'MATERIAL_PAYMENT', 'MATERIAL_MGMT', 'OUTSOURCE_SCHEDULE', 'OUTSOURCE_QUALITY', 'WORKSHOP', 'CUSTOMER', 'OTHER') NOT NULL,
    `description` TEXT NOT NULL,
    `photos` JSON NULL,
    `reporterId` VARCHAR(64) NULL,
    `source` ENUM('MANUAL', 'ALERT', 'QMS_NONCONFORMING') NOT NULL,
    `responsibleDeptId` VARCHAR(64) NULL,
    `responsibleUserId` VARCHAR(64) NULL,
    `responsibleSupplierId` VARCHAR(64) NULL,
    `dueDate` DATETIME(3) NULL,
    `status` ENUM('OPEN', 'ACCEPTED', 'RESOLVED', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `escalationLevel` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `issue_issueNo_key`(`issueNo`),
    INDEX `issue_workOrderNumber_status_idx`(`workOrderNumber`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `issue_log` (
    `id` VARCHAR(191) NOT NULL,
    `issueId` VARCHAR(191) NOT NULL,
    `fromStatus` ENUM('OPEN', 'ACCEPTED', 'RESOLVED', 'CLOSED') NULL,
    `toStatus` ENUM('OPEN', 'ACCEPTED', 'RESOLVED', 'CLOSED') NULL,
    `note` TEXT NULL,
    `actorId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `issue_log_issueId_idx`(`issueId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `alert` (
    `id` VARCHAR(191) NOT NULL,
    `rule` ENUM('W1', 'W2', 'W3', 'W4') NOT NULL,
    `refType` VARCHAR(20) NOT NULL,
    `refId` VARCHAR(64) NOT NULL,
    `level` ENUM('REMIND', 'YELLOW', 'RED') NOT NULL,
    `firstAt` DATETIME(3) NOT NULL,
    `levelAt` DATETIME(3) NOT NULL,
    `lastNotifiedAt` DATETIME(3) NULL,
    `status` ENUM('ACTIVE', 'CLEARED', 'CONVERTED') NOT NULL DEFAULT 'ACTIVE',
    `activeKey` VARCHAR(120) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `alert_activeKey_key`(`activeKey`),
    INDEX `alert_refType_refId_idx`(`refType`, `refId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reminder` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(64) NOT NULL,
    `alertId` VARCHAR(191) NULL,
    `todoId` VARCHAR(191) NULL,
    `title` VARCHAR(191) NOT NULL,
    `level` ENUM('REMIND', 'YELLOW', 'RED') NOT NULL DEFAULT 'REMIND',
    `readAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `reminder_userId_readAt_idx`(`userId`, `readAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `threshold` (
    `rule` ENUM('W1', 'W2', 'W3', 'W4') NOT NULL,
    `remindHours` INTEGER NULL,
    `yellowDays` INTEGER NOT NULL,
    `redDays` INTEGER NOT NULL,

    PRIMARY KEY (`rule`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `off_day` (
    `date` DATE NOT NULL,

    PRIMARY KEY (`date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `session` (
    `id` CHAR(64) NOT NULL,
    `qmsUserId` VARCHAR(64) NOT NULL,
    `userName` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `session_qmsUserId_idx`(`qmsUserId`),
    INDEX `session_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `login_attempt` (
    `id` CHAR(64) NOT NULL,
    `codeVerifier` VARCHAR(128) NOT NULL,
    `redirect` VARCHAR(512) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `login_attempt_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `route_step` ADD CONSTRAINT `route_step_partId_fkey` FOREIGN KEY (`partId`) REFERENCES `part`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `flow_event` ADD CONSTRAINT `flow_event_stepId_fkey` FOREIGN KEY (`stepId`) REFERENCES `route_step`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `issue_log` ADD CONSTRAINT `issue_log_issueId_fkey` FOREIGN KEY (`issueId`) REFERENCES `issue`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
