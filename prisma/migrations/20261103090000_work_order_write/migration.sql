-- 履约新建 / 修改 / 取消工单（写入 QMS 工单库，10-27 zhao 定）：工单副本加客户 ID、事业部 ID、乐观锁版本号。只加可空列，不改已有数据。
-- AlterTable
ALTER TABLE `qms_work_order` ADD COLUMN `customerNameId` VARCHAR(64) NULL,
    ADD COLUMN `divisionId` VARCHAR(64) NULL,
    ADD COLUMN `version` INTEGER NULL;

-- 工单同步游标归零：增量同步只拉 updatedAt 变过的工单，已有工单的新字段（客户 ID、事业部、版本号）永远拉不到。
-- 归零后下一轮同步把全部工单重拉一遍（几百行，upsert 幂等，不产生提醒）。要求 QMS 先发版（新字段已输出）；
-- 如果履约先上线，QMS 发版后再手工执行一次本语句。
UPDATE `sync_cursor` SET `since` = NULL, `afterId` = NULL WHERE `resource` = 'work-orders';
