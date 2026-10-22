-- 部门计划二次分解（10-22）：总计划节点下的"其他任务"（节点删除时一起删）；W9 增加"节点未分解"提醒
-- CreateTable
CREATE TABLE `plan_task` (
    `id` VARCHAR(191) NOT NULL,
    `workOrderNumber` VARCHAR(64) NOT NULL,
    `planNodeId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `ownerId` VARCHAR(64) NOT NULL,
    `planDate` DATETIME(3) NOT NULL,
    `doneDate` DATETIME(3) NULL,
    `doneBy` VARCHAR(64) NULL,
    `note` VARCHAR(500) NULL,
    `createdBy` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `plan_task_planNodeId_idx`(`planNodeId`),
    INDEX `plan_task_workOrderNumber_idx`(`workOrderNumber`),
    INDEX `plan_task_ownerId_idx`(`ownerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `plan_task` ADD CONSTRAINT `plan_task_planNodeId_fkey` FOREIGN KEY (`planNodeId`) REFERENCES `plan_node`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- W9 的"提醒小时数"用作：总计划发布（或节点发布后新增）多少小时后节点仍没有任何部门任务就提醒部门负责人。默认 72 小时（3 天）；
-- 原来是空（W9 不提醒），只改空的，设置页改过的不覆盖
UPDATE `threshold` SET `remindHours` = 72 WHERE `rule` = 'W9' AND `remindHours` IS NULL;
