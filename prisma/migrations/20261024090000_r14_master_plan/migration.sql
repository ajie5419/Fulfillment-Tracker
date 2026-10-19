-- R14 项目部总计划：模板（交期前天数倒推）、工单总计划（草稿 / 已发布、基线）、节点（责任部门、部门确认）、调整记录；
-- 出图任务、采购行、工序、装配节点挂到总计划节点（可空，老数据不挂；节点删除时置空）；W9 总计划节点延误预警

-- AlterTable
ALTER TABLE `alert` MODIFY `rule` ENUM('W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9') NOT NULL;

-- AlterTable
ALTER TABLE `assembly_node` ADD COLUMN `planNodeId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `drawing_task` ADD COLUMN `planNodeId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `purchase_line` ADD COLUMN `planNodeId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `route_step` ADD COLUMN `planNodeId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `threshold` MODIFY `rule` ENUM('W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9') NOT NULL;

-- CreateTable
CREATE TABLE `plan_template` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(500) NULL,
    `createdBy` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `plan_template_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plan_template_node` (
    `id` VARCHAR(191) NOT NULL,
    `templateId` VARCHAR(191) NOT NULL,
    `seq` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `dept` ENUM('TECH', 'PURCHASE', 'PRODUCTION', 'QUALITY', 'FINANCE', 'PROJECT') NOT NULL,
    `daysBeforeDelivery` INTEGER NOT NULL,

    UNIQUE INDEX `plan_template_node_templateId_seq_key`(`templateId`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `work_order_plan` (
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `status` ENUM('DRAFT', 'PUBLISHED') NOT NULL DEFAULT 'DRAFT',
    `templateName` VARCHAR(191) NULL,
    `publishedAt` DATETIME(3) NULL,
    `publishedBy` VARCHAR(64) NULL,
    `createdBy` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`workOrderNumber`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plan_node` (
    `id` VARCHAR(191) NOT NULL,
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `seq` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `dept` ENUM('TECH', 'PURCHASE', 'PRODUCTION', 'QUALITY', 'FINANCE', 'PROJECT') NOT NULL,
    `planDate` DATETIME(3) NOT NULL,
    `baselineDate` DATETIME(3) NULL,
    `actualDate` DATETIME(3) NULL,
    `manualDoneBy` VARCHAR(64) NULL,
    `manualDoneAt` DATETIME(3) NULL,
    `confirmStatus` ENUM('PENDING', 'CONFIRMED', 'REJECTED') NULL,
    `confirmedBy` VARCHAR(64) NULL,
    `confirmedAt` DATETIME(3) NULL,
    `rejectReason` VARCHAR(500) NULL,
    `note` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `plan_node_workOrderNumber_seq_idx`(`workOrderNumber`, `seq`),
    INDEX `plan_node_confirmStatus_idx`(`confirmStatus`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plan_change_log` (
    `id` VARCHAR(191) NOT NULL,
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `nodeId` VARCHAR(191) NOT NULL,
    `nodeName` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(20) NOT NULL,
    `oldDate` DATETIME(3) NULL,
    `newDate` DATETIME(3) NULL,
    `reason` VARCHAR(500) NOT NULL,
    `actorId` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `plan_change_log_workOrderNumber_createdAt_idx`(`workOrderNumber`, `createdAt`),
    INDEX `plan_change_log_nodeId_idx`(`nodeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `assembly_node_planNodeId_idx` ON `assembly_node`(`planNodeId`);

-- CreateIndex
CREATE INDEX `drawing_task_planNodeId_idx` ON `drawing_task`(`planNodeId`);

-- CreateIndex
CREATE INDEX `purchase_line_planNodeId_idx` ON `purchase_line`(`planNodeId`);

-- CreateIndex
CREATE INDEX `route_step_planNodeId_idx` ON `route_step`(`planNodeId`);

-- AddForeignKey
ALTER TABLE `route_step` ADD CONSTRAINT `route_step_planNodeId_fkey` FOREIGN KEY (`planNodeId`) REFERENCES `plan_node`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_line` ADD CONSTRAINT `purchase_line_planNodeId_fkey` FOREIGN KEY (`planNodeId`) REFERENCES `plan_node`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `drawing_task` ADD CONSTRAINT `drawing_task_planNodeId_fkey` FOREIGN KEY (`planNodeId`) REFERENCES `plan_node`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `assembly_node` ADD CONSTRAINT `assembly_node_planNodeId_fkey` FOREIGN KEY (`planNodeId`) REFERENCES `plan_node`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plan_template_node` ADD CONSTRAINT `plan_template_node_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `plan_template`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- W9 默认阈值：节点预计完成日晚于计划日 1 天 → 黄；晚 3 天及以上 → 红（预计交期晚于 QMS 交期也红）；不提醒（已有的不覆盖）
INSERT IGNORE INTO `threshold` (`rule`, `remindHours`, `yellowDays`, `redDays`) VALUES ('W9', NULL, 1, 3);

-- 内置"通用"模板（11 个节点）。"交期前天数"是按常见非标设备周期取的参考值，责任部门按常见分工；
-- 都可以在设置页"总计划模板"里改，也可以另建"高铁架设设备""特种车辆""风电模具"等模板。已有同名模板时不写。
INSERT IGNORE INTO `plan_template` (`id`, `name`, `description`, `createdBy`, `createdAt`, `updatedAt`)
VALUES ('plan-tpl-generic', '通用', '内置模板：交期前天数为参考值，按工单实际情况调整', NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

INSERT IGNORE INTO `plan_template_node` (`id`, `templateId`, `seq`, `name`, `dept`, `daysBeforeDelivery`)
SELECT CONCAT('plan-tpl-generic-', LPAD(n.seq, 2, '0')), t.id, n.seq, n.name, n.dept, n.days
FROM `plan_template` t
JOIN (
    SELECT 1 AS seq, '合同评审' AS name, 'PROJECT' AS dept, 120 AS days
    UNION ALL SELECT 2, '设计出图', 'TECH', 100
    UNION ALL SELECT 3, '客户确认', 'PROJECT', 90
    UNION ALL SELECT 4, '关键物料到货', 'PURCHASE', 60
    UNION ALL SELECT 5, '下料组焊', 'PRODUCTION', 45
    UNION ALL SELECT 6, '机加', 'PRODUCTION', 35
    UNION ALL SELECT 7, '外协', 'PRODUCTION', 28
    UNION ALL SELECT 8, '涂装', 'PRODUCTION', 18
    UNION ALL SELECT 9, '装配', 'PRODUCTION', 10
    UNION ALL SELECT 10, '调试', 'TECH', 5
    UNION ALL SELECT 11, '发运', 'PROJECT', 0
) n
WHERE t.id = 'plan-tpl-generic';
