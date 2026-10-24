-- 技术部 BOM Excel 导入：工件记版号、来源标记；按 (工单, 图号) 查重和关联 QMS BOM

-- AlterTable
ALTER TABLE `part` ADD COLUMN `revision` VARCHAR(64) NULL,
    ADD COLUMN `fromTechBom` BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX `part_workOrderNumber_drawingNo_idx` ON `part`(`workOrderNumber`, `drawingNo`);

-- DropIndex
DROP INDEX `part_workOrderNumber_idx` ON `part`;
