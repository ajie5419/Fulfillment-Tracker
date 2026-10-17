-- R10 关键物料到货 + 付款：采购跟踪行、进货检验自动到货记录、付款申请；W6 关键物料未到货预警；财务角色

-- 预警规则加 W6（关键物料未到货）
ALTER TABLE `alert` MODIFY `rule` ENUM('W1', 'W2', 'W3', 'W4', 'W5', 'W6') NOT NULL;
ALTER TABLE `threshold` MODIFY `rule` ENUM('W1', 'W2', 'W3', 'W4', 'W5', 'W6') NOT NULL;

-- 通知对象加 财务（付款申请标记已付 / 暂缓）
ALTER TABLE `notify_role` MODIFY `role` ENUM('OUTSOURCE_COORDINATOR', 'DEPT_HEAD', 'PROJECT_DEPT_HEAD', 'LEADER', 'FINANCE') NOT NULL;

-- CreateTable
CREATE TABLE `purchase_line` (
    `id` VARCHAR(191) NOT NULL,
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `partId` VARCHAR(191) NULL,
    `materialName` VARCHAR(191) NOT NULL,
    `spec` VARCHAR(191) NULL,
    `quantity` DECIMAL(14, 3) NOT NULL,
    `unit` VARCHAR(20) NULL,
    `supplierId` VARCHAR(64) NULL,
    `supplierName` VARCHAR(191) NULL,
    `needDate` DATETIME(3) NOT NULL,
    `promisedDate` DATETIME(3) NULL,
    `arrivedDate` DATETIME(3) NULL,
    `status` ENUM('OPEN', 'ARRIVED', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    `buyerId` VARCHAR(64) NULL,
    `delayReason` ENUM('PAYMENT', 'SUPPLIER', 'DEMAND_CHANGE', 'OTHER') NULL,
    `delayNote` VARCHAR(500) NULL,
    `note` VARCHAR(500) NULL,
    `arrivalSource` ENUM('MOBILE', 'QMS_INSPECTION', 'PC') NULL,
    `arrivedBy` VARCHAR(64) NULL,
    `arrivedAt` DATETIME(3) NULL,
    `qmsInspectionId` VARCHAR(64) NULL,
    `createdBy` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `purchase_line_qmsInspectionId_key`(`qmsInspectionId`),
    INDEX `purchase_line_workOrderNumber_status_idx`(`workOrderNumber`, `status`),
    INDEX `purchase_line_status_needDate_idx`(`status`, `needDate`),
    INDEX `purchase_line_partId_idx`(`partId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `incoming_check` (
    `qmsInspectionId` VARCHAR(64) NOT NULL,
    `result` VARCHAR(20) NOT NULL,
    `purchaseLineId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`qmsInspectionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_request` (
    `id` VARCHAR(191) NOT NULL,
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `requestDate` DATETIME(3) NOT NULL,
    `blocksDelivery` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('PENDING', 'PAID', 'ON_HOLD') NOT NULL DEFAULT 'PENDING',
    `note` VARCHAR(500) NULL,
    `financeNote` VARCHAR(500) NULL,
    `requesterId` VARCHAR(64) NOT NULL,
    `statusBy` VARCHAR(64) NULL,
    `statusAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `payment_request_status_idx`(`status`),
    INDEX `payment_request_workOrderNumber_idx`(`workOrderNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_request_line` (
    `paymentId` VARCHAR(191) NOT NULL,
    `purchaseLineId` VARCHAR(191) NOT NULL,

    INDEX `payment_request_line_purchaseLineId_idx`(`purchaseLineId`),
    PRIMARY KEY (`paymentId`, `purchaseLineId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `purchase_line` ADD CONSTRAINT `purchase_line_partId_fkey` FOREIGN KEY (`partId`) REFERENCES `part`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_request_line` ADD CONSTRAINT `payment_request_line_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payment_request`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_request_line` ADD CONSTRAINT `payment_request_line_purchaseLineId_fkey` FOREIGN KEY (`purchaseLineId`) REFERENCES `purchase_line`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- W6 默认阈值：需求日前 7 天（168 小时）仍无承诺日 → 黄；超承诺到货日 1 天黄、3 天红；需求日已过仍未到货直接红（已有的不覆盖）
INSERT IGNORE INTO `threshold` (`rule`, `remindHours`, `yellowDays`, `redDays`) VALUES ('W6', 168, 1, 3);
