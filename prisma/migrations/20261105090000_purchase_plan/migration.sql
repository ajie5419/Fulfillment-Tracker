-- CreateTable
CREATE TABLE `purchase_plan` (
    `id` VARCHAR(191) NOT NULL,
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `category` VARCHAR(191) NOT NULL DEFAULT '',
    `planNodeId` VARCHAR(191) NULL,
    `status` ENUM('DRAFT', 'ISSUED', 'WITHDRAWN') NOT NULL DEFAULT 'DRAFT',
    `source` ENUM('MANUAL', 'BOM_AUTO') NOT NULL DEFAULT 'MANUAL',
    `createdBy` VARCHAR(64) NOT NULL,
    `issuedBy` VARCHAR(64) NULL,
    `issuedAt` DATETIME(3) NULL,
    `note` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `purchase_plan_workOrderNumber_status_idx`(`workOrderNumber`, `status`),
    INDEX `purchase_plan_planNodeId_idx`(`planNodeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_plan_item` (
    `id` VARCHAR(191) NOT NULL,
    `planId` VARCHAR(191) NOT NULL,
    `materialName` VARCHAR(191) NOT NULL,
    `spec` VARCHAR(191) NULL,
    `quantity` DECIMAL(14, 3) NOT NULL,
    `unit` VARCHAR(20) NULL,
    `needDate` DATETIME(3) NULL,
    `partId` VARCHAR(191) NULL,
    `supplierName` VARCHAR(191) NULL,
    `note` VARCHAR(500) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `convertedLineId` VARCHAR(191) NULL,

    UNIQUE INDEX `purchase_plan_item_convertedLineId_key`(`convertedLineId`),
    INDEX `purchase_plan_item_planId_sortOrder_idx`(`planId`, `sortOrder`),
    INDEX `purchase_plan_item_partId_idx`(`partId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `purchase_plan` ADD CONSTRAINT `purchase_plan_planNodeId_fkey` FOREIGN KEY (`planNodeId`) REFERENCES `plan_node`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_plan_item` ADD CONSTRAINT `purchase_plan_item_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `purchase_plan`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_plan_item` ADD CONSTRAINT `purchase_plan_item_partId_fkey` FOREIGN KEY (`partId`) REFERENCES `part`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_plan_item` ADD CONSTRAINT `purchase_plan_item_convertedLineId_fkey` FOREIGN KEY (`convertedLineId`) REFERENCES `purchase_line`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

