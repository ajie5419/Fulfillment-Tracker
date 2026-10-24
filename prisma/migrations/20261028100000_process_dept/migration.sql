-- 新增业务部门"工艺部"（10-24，zhao：工艺按图纸分解料单、发下料车间下料，编制、下发工艺文件，定工艺路线）

-- AlterTable
ALTER TABLE `dept_mapping` MODIFY `businessDept` ENUM('TECH', 'PROCESS', 'PURCHASE', 'PRODUCTION', 'QUALITY', 'FINANCE', 'PROJECT') NOT NULL;

-- AlterTable
ALTER TABLE `plan_template_node` MODIFY `dept` ENUM('TECH', 'PROCESS', 'PURCHASE', 'PRODUCTION', 'QUALITY', 'FINANCE', 'PROJECT') NOT NULL;

-- AlterTable
ALTER TABLE `plan_node` MODIFY `dept` ENUM('TECH', 'PROCESS', 'PURCHASE', 'PRODUCTION', 'QUALITY', 'FINANCE', 'PROJECT') NOT NULL;

-- 内置"特种车辆"模板：车架下的工艺、料单两个子节点改由工艺部负责（原来记在技术部），名称按工艺的职责写清楚。
-- 只改模板（模板 ID 固定）；已经建好的总计划不动，需要的话在计划里把这两个节点的责任部门改成工艺部。
UPDATE `plan_template_node` SET `dept` = 'PROCESS', `name` = '车架工艺路线、工艺文件编制下发'
WHERE `id` = 'plan-tpl-special-vehicle-16' AND `name` = '车架制作工艺';
UPDATE `plan_template_node` SET `dept` = 'PROCESS', `name` = '车架料单分解（发下料车间）'
WHERE `id` = 'plan-tpl-special-vehicle-17' AND `name` = '车架料单制作';
