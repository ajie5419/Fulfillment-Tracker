ALTER TABLE `plan_template_node` ADD COLUMN `requiresProcess` BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE `plan_node` ADD COLUMN `requiresProcess` BOOLEAN NOT NULL DEFAULT true;

-- One-time compatibility backfill. Runtime routing uses the explicit flag only.
UPDATE `plan_template_node`
SET `requiresProcess` = false
WHERE `name` LIKE '%采购计划%' OR `name` = '调试';

UPDATE `plan_node`
SET `requiresProcess` = false
WHERE `name` LIKE '%采购计划%' OR `name` = '调试';
