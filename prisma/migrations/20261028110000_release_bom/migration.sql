-- 图纸发放单附技术部 BOM 表（10-24，zhao：BOM 不单独导入，随图纸下发；发放时按图号建工件）

-- AlterTable
ALTER TABLE `doc_release` ADD COLUMN `bomFileId` VARCHAR(64) NULL;

-- .xlsx 的 MIME（application/vnd.openxmlformats-officedocument.spreadsheetml.sheet）有 65 个字符，原来 40 放不下
ALTER TABLE `upload_file` MODIFY `mime` VARCHAR(100) NOT NULL;
