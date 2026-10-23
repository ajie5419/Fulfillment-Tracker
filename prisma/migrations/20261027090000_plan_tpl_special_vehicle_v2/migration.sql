-- 内置"特种车辆"模板第二版（10-23，zhao：新建计划时就要带上"缺什么影响什么"的关联）：
--   1. 车架改成汇总行，拆成 5 个子节点（按《机场行李车项目计划》1.4.1 车架）：车架制作工艺、车架料单制作（等结构图纸）、
--      下料（等料单 + 原材料采购及复验）、组对焊接（等下料）、加工（等组对焊接）。原材料晚了只影响下料、组焊、加工和后面，工艺、料单不受影响；
--   2. 加"外购件图纸、技术协议"（和外购件采购计划同期），车桥、油缸、电气件、液压件采购都要等它；
--   3. 调试后加"验收"（质量部，1 天），调试工期 8 → 7 天（开始日不变），发货等验收。
--   交期前天数、工期按原计划（交期 10-31）换算，都可以在设置页改。只改内置模板的节点（模板 ID 固定）；用户自建的模板不动。
DELETE FROM `plan_template_node` WHERE `templateId` = 'plan-tpl-special-vehicle';

INSERT INTO `plan_template_node` (`id`, `templateId`, `seq`, `name`, `dept`, `daysBeforeDelivery`, `phase`, `durationDays`, `predSeqs`, `parentSeq`)
SELECT CONCAT('plan-tpl-special-vehicle-', LPAD(n.seq, 2, '0')), t.id, n.seq, n.name, n.dept, n.days, n.phase, n.dur, CAST(CONCAT('[', n.preds, ']') AS JSON), n.parent
FROM `plan_template` t
JOIN (
    SELECT 1 AS seq, '开工通知' AS name, 'PROJECT' AS dept, '开工通知' AS phase, 99 AS days, 1 AS dur, '' AS preds, NULL AS parent
    UNION ALL SELECT 2, '结构图纸', 'TECH', '图纸设计及文件下发', 46, 53, '1', NULL
    UNION ALL SELECT 3, '原材料采购计划', 'TECH', '图纸设计及文件下发', 54, 45, '1', NULL
    UNION ALL SELECT 4, '外购件图纸、技术协议', 'TECH', '图纸设计及文件下发', 81, 18, '1', NULL
    UNION ALL SELECT 5, '主要外购件采购计划', 'TECH', '图纸设计及文件下发', 81, 18, '1', NULL
    UNION ALL SELECT 6, '其他外购件采购计划', 'TECH', '图纸设计及文件下发', 74, 25, '1', NULL
    UNION ALL SELECT 7, '电器件采购计划', 'TECH', '图纸设计及文件下发', 81, 18, '1', NULL
    UNION ALL SELECT 8, '液压件采购计划', 'TECH', '图纸设计及文件下发', 81, 18, '1', NULL
    UNION ALL SELECT 9, '原材料采购及复验', 'PURCHASE', '采购', 31, 23, '3', NULL
    UNION ALL SELECT 10, '车桥、轮辋、轮胎', 'PURCHASE', '采购', 18, 63, '4, 5', NULL
    UNION ALL SELECT 11, '油缸', 'PURCHASE', '采购', 21, 60, '4, 5', NULL
    UNION ALL SELECT 12, '标准件', 'PURCHASE', '采购', 21, 53, '6', NULL
    UNION ALL SELECT 13, '电气件', 'PURCHASE', '采购', 21, 60, '4, 7', NULL
    UNION ALL SELECT 14, '液压件', 'PURCHASE', '采购', 21, 60, '4, 8', NULL
    UNION ALL SELECT 15, '车架', 'PRODUCTION', '生产制作', 19, 27, '', NULL
    UNION ALL SELECT 16, '车架制作工艺', 'TECH', '生产制作', 39, 7, '2', 15
    UNION ALL SELECT 17, '车架料单制作', 'TECH', '生产制作', 39, 7, '2', 15
    UNION ALL SELECT 18, '下料', 'PRODUCTION', '生产制作', 30, 1, '17, 9', 15
    UNION ALL SELECT 19, '组对焊接', 'PRODUCTION', '生产制作', 25, 5, '18', 15
    UNION ALL SELECT 20, '加工', 'PRODUCTION', '生产制作', 19, 6, '19', 15
    UNION ALL SELECT 21, '表面处理喷漆', 'PRODUCTION', '表面处理', 17, 2, '15', NULL
    UNION ALL SELECT 22, '装配', 'PRODUCTION', '装配、调试、发运', 9, 8, '10, 11, 12, 13, 14, 21', NULL
    UNION ALL SELECT 23, '调试', 'TECH', '装配、调试、发运', 2, 7, '22', NULL
    UNION ALL SELECT 24, '验收', 'QUALITY', '装配、调试、发运', 1, 1, '23', NULL
    UNION ALL SELECT 25, '发货', 'PROJECT', '装配、调试、发运', 0, 1, '24', NULL
) n
WHERE t.id = 'plan-tpl-special-vehicle';

UPDATE `plan_template` SET `description` = '内置模板：按机场行李车项目计划整理（100 天），含阶段、工期、前置节点，车架拆到下料、组焊、加工；按工单实际情况调整', `updatedAt` = CURRENT_TIMESTAMP(3)
WHERE `id` = 'plan-tpl-special-vehicle';

-- 已有总计划里的上级节点改成汇总行（和服务层 rollupParents 一致）：日期按子节点汇总（最早开始～最晚完成；开始 = 完成时不另存开始日），
-- 不用部门确认（确认状态清空，没处理的确认待办作废）。没有子节点的数据不变。
UPDATE `plan_node` p
JOIN (
    SELECT `parentId`, MAX(`planDate`) AS mx, MIN(COALESCE(`startDate`, `planDate`)) AS mn
    FROM `plan_node` WHERE `parentId` IS NOT NULL GROUP BY `parentId`
) c ON c.`parentId` = p.`id`
SET p.`planDate` = c.mx,
    p.`startDate` = IF(c.mn = c.mx, NULL, c.mn),
    p.`confirmStatus` = NULL, p.`confirmedBy` = NULL, p.`confirmedAt` = NULL, p.`rejectReason` = NULL;

UPDATE `todo` SET `status` = 'CANCELLED', `doneAt` = CURRENT_TIMESTAMP(3)
WHERE `refType` = 'planNode' AND `action` = 'CONFIRM_PLAN_NODE' AND `status` = 'OPEN'
  AND `refId` IN (SELECT `parentId` FROM (SELECT DISTINCT `parentId` FROM `plan_node` WHERE `parentId` IS NOT NULL) x);
