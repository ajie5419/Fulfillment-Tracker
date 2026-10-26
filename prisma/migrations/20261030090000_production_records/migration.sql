-- 生产管理补全（10-26）：部分完工 / 报废事件、发出随件发料备注、报废转异常来源、工序应开工日。只加列和枚举值，不改已有数据
-- AlterTable
ALTER TABLE `flow_event` ADD COLUMN `note` VARCHAR(500) NULL,
    MODIFY `type` ENUM('SEND', 'RETURN', 'RETURN_MANUAL', 'START', 'FINISH', 'REPORT', 'SCRAP') NOT NULL;

-- AlterTable
ALTER TABLE `issue` MODIFY `source` ENUM('MANUAL', 'ALERT', 'QMS_NONCONFORMING', 'SCRAP') NOT NULL;

-- AlterTable
ALTER TABLE `route_step` ADD COLUMN `planStartDate` DATETIME(3) NULL;

