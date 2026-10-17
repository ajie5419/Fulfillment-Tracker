-- R2 接入 QMS 真实数据：副本表按同步接口契约 v1 补字段；同步游标记录最后成功时间和故障提醒

-- 报检：多工单、厂内外协班组、报检类别、QMS 质量问题单 ID
ALTER TABLE `qms_inspection` ADD COLUMN `category` VARCHAR(40) NULL,
    ADD COLUMN `linkedIssueId` VARCHAR(64) NULL,
    ADD COLUMN `teamId` VARCHAR(64) NULL,
    ADD COLUMN `teamName` VARCHAR(191) NULL,
    ADD COLUMN `workOrderNumbers` JSON NULL;
CREATE INDEX `qms_inspection_teamId_idx` ON `qms_inspection`(`teamId`);

-- 工序：编码、启用状态；supplierSource 同步接口不输出，给默认值
ALTER TABLE `qms_process` ADD COLUMN `code` VARCHAR(64) NULL,
    ADD COLUMN `status` INTEGER NOT NULL DEFAULT 1,
    MODIFY `supplierSource` VARCHAR(20) NOT NULL DEFAULT 'Supplier';

-- 外协单位：类型（SUPPLIER 供应商 / TEAM 厂内外协班组）、QMS 状态
ALTER TABLE `qms_supplier` ADD COLUMN `kind` VARCHAR(20) NOT NULL DEFAULT 'SUPPLIER',
    ADD COLUMN `status` VARCHAR(40) NULL;

-- 用户：QMS 的 users.department 存的是部门 ID。先加 departmentId，把已有行（演示数据存的是部门名称）按名称换成 ID，再删旧列；
-- 不再保存手机号（数据最小化）；roleId 同步接口不输出，改为可空
ALTER TABLE `qms_user` ADD COLUMN `departmentId` VARCHAR(64) NULL,
    MODIFY `roleId` VARCHAR(64) NULL;
UPDATE `qms_user` u SET u.`departmentId` = COALESCE(
    (SELECT MIN(d.`id`) FROM `qms_department` d WHERE d.`name` = u.`department` AND d.`isDeleted` = false),
    (SELECT MIN(d.`id`) FROM `qms_department` d WHERE d.`id` = u.`department`)
);
ALTER TABLE `qms_user` DROP COLUMN `department`,
    DROP COLUMN `phone`;
CREATE INDEX `qms_user_departmentId_idx` ON `qms_user`(`departmentId`);

-- 同步游标：最后成功追平时间、本轮故障已提醒管理员的时间
ALTER TABLE `sync_cursor` ADD COLUMN `alertedAt` DATETIME(3) NULL,
    ADD COLUMN `lastSyncedAt` DATETIME(3) NULL;
