-- R12 齐套：装配节点（工单下的总装 / 部装节点）、节点清单（工件 + 关键物料，可挂多个节点）、W8 未齐套预警

-- AlterTable
ALTER TABLE `alert` MODIFY `rule` ENUM('W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8') NOT NULL;

-- AlterTable
ALTER TABLE `threshold` MODIFY `rule` ENUM('W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8') NOT NULL;

-- CreateTable
CREATE TABLE `assembly_node` (
    `id` VARCHAR(191) NOT NULL,
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `needDate` DATETIME(3) NOT NULL,
    `ownerId` VARCHAR(64) NULL,
    `note` VARCHAR(500) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdBy` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `assembly_node_workOrderNumber_sortOrder_idx`(`workOrderNumber`, `sortOrder`),
    INDEX `assembly_node_needDate_idx`(`needDate`),
    INDEX `assembly_node_ownerId_idx`(`ownerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `assembly_node_part` (
    `nodeId` VARCHAR(191) NOT NULL,
    `partId` VARCHAR(191) NOT NULL,

    INDEX `assembly_node_part_partId_idx`(`partId`),
    PRIMARY KEY (`nodeId`, `partId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `assembly_node_purchase` (
    `nodeId` VARCHAR(191) NOT NULL,
    `purchaseLineId` VARCHAR(191) NOT NULL,

    INDEX `assembly_node_purchase_purchaseLineId_idx`(`purchaseLineId`),
    PRIMARY KEY (`nodeId`, `purchaseLineId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `assembly_node_part` ADD CONSTRAINT `assembly_node_part_nodeId_fkey` FOREIGN KEY (`nodeId`) REFERENCES `assembly_node`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `assembly_node_part` ADD CONSTRAINT `assembly_node_part_partId_fkey` FOREIGN KEY (`partId`) REFERENCES `part`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `assembly_node_purchase` ADD CONSTRAINT `assembly_node_purchase_nodeId_fkey` FOREIGN KEY (`nodeId`) REFERENCES `assembly_node`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `assembly_node_purchase` ADD CONSTRAINT `assembly_node_purchase_purchaseLineId_fkey` FOREIGN KEY (`purchaseLineId`) REFERENCES `purchase_line`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- W8 默认阈值：需求日前 5 天仍未齐套 → 黄；前 1 天（含当天、已过）仍未齐套 → 红；不提醒（已有的不覆盖）
INSERT IGNORE INTO `threshold` (`rule`, `remindHours`, `yellowDays`, `redDays`) VALUES ('W8', NULL, 5, 1);
