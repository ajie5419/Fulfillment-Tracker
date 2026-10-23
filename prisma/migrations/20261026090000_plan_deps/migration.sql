-- 总计划前置节点、阶段、计划开始日（10-22，按真实 MS Project 计划：多条线并行）
-- AlterTable
ALTER TABLE `plan_node` ADD COLUMN `customDeps` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `phase` VARCHAR(64) NULL,
    ADD COLUMN `startDate` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `plan_template_node` ADD COLUMN `durationDays` INTEGER NULL,
    ADD COLUMN `phase` VARCHAR(64) NULL,
    ADD COLUMN `predSeqs` JSON NULL;

-- CreateTable
CREATE TABLE `plan_node_dep` (
    `nodeId` VARCHAR(191) NOT NULL,
    `predId` VARCHAR(191) NOT NULL,

    INDEX `plan_node_dep_predId_idx`(`predId`),
    PRIMARY KEY (`nodeId`, `predId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `plan_node_dep` ADD CONSTRAINT `plan_node_dep_nodeId_fkey` FOREIGN KEY (`nodeId`) REFERENCES `plan_node`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plan_node_dep` ADD CONSTRAINT `plan_node_dep_predId_fkey` FOREIGN KEY (`predId`) REFERENCES `plan_node`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;




-- 内置"特种车辆"模板（10-22，按项目部在用的《机场行李车项目计划》MS Project 计划整理，18 个节点）：
--   阶段 = 计划里的一级（开工通知 / 图纸设计及文件下发 / 采购 / 生产制作 / 表面处理 / 装配、调试、发运）；
--   节点 = 二级事项（车架下的工艺、料单、下料、组焊、加工由生产部在节点下分解）；交期前天数、工期按原计划（交期 10-31、工期 100 天）换算；
--   前置节点按原计划的连线：各类采购清单 → 对应采购，结构图纸 + 原材料 → 车架，各类采购 + 喷漆 → 装配。
--   清单类节点（原材料 / 外购件 / 电器件 / 液压件采购计划）原计划在"图纸设计及文件下发"阶段，责任部门暂按技术部；都可以在设置页改。已有同名模板时不写。
INSERT IGNORE INTO `plan_template` (`id`, `name`, `description`, `createdBy`, `createdAt`, `updatedAt`)
VALUES ('plan-tpl-special-vehicle', '特种车辆', '内置模板：按机场行李车项目计划整理（100 天），含阶段、工期和前置节点；按工单实际情况调整', NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

INSERT IGNORE INTO `plan_template_node` (`id`, `templateId`, `seq`, `name`, `dept`, `daysBeforeDelivery`, `phase`, `durationDays`, `predSeqs`)
SELECT CONCAT('plan-tpl-special-vehicle-', LPAD(n.seq, 2, '0')), t.id, n.seq, n.name, n.dept, n.days, n.phase, n.dur, CAST(CONCAT('[', n.preds, ']') AS JSON)
FROM `plan_template` t
JOIN (
    SELECT 1 AS seq, '开工通知' AS name, 'PROJECT' AS dept, '开工通知' AS phase, 99 AS days, 1 AS dur, '' AS preds
    UNION ALL SELECT 2, '结构图纸', 'TECH', '图纸设计及文件下发', 46, 53, '1'
    UNION ALL SELECT 3, '原材料采购计划', 'TECH', '图纸设计及文件下发', 54, 45, '1'
    UNION ALL SELECT 4, '主要外购件采购计划', 'TECH', '图纸设计及文件下发', 81, 18, '1'
    UNION ALL SELECT 5, '其他外购件采购计划', 'TECH', '图纸设计及文件下发', 74, 25, '1'
    UNION ALL SELECT 6, '电器件采购计划', 'TECH', '图纸设计及文件下发', 81, 18, '1'
    UNION ALL SELECT 7, '液压件采购计划', 'TECH', '图纸设计及文件下发', 81, 18, '1'
    UNION ALL SELECT 8, '原材料采购及复验', 'PURCHASE', '采购', 31, 23, '3'
    UNION ALL SELECT 9, '车桥、轮辋、轮胎', 'PURCHASE', '采购', 18, 63, '4'
    UNION ALL SELECT 10, '油缸', 'PURCHASE', '采购', 21, 60, '4'
    UNION ALL SELECT 11, '标准件', 'PURCHASE', '采购', 21, 53, '5'
    UNION ALL SELECT 12, '电气件', 'PURCHASE', '采购', 21, 60, '6'
    UNION ALL SELECT 13, '液压件', 'PURCHASE', '采购', 21, 60, '7'
    UNION ALL SELECT 14, '车架', 'PRODUCTION', '生产制作', 19, 27, '2, 8'
    UNION ALL SELECT 15, '表面处理喷漆', 'PRODUCTION', '表面处理', 17, 2, '14'
    UNION ALL SELECT 16, '装配', 'PRODUCTION', '装配、调试、发运', 9, 8, '9, 10, 11, 12, 13, 15'
    UNION ALL SELECT 17, '调试', 'TECH', '装配、调试、发运', 1, 8, '16'
    UNION ALL SELECT 18, '发货', 'PROJECT', '装配、调试、发运', 0, 1, '17'
) n
WHERE t.id = 'plan-tpl-special-vehicle';
