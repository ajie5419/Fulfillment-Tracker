-- R8 工艺：工件记录来源 QMS BOM 行（同工单唯一，重复导入跳过）；工序路线模板及其步骤

-- AlterTable
ALTER TABLE `part` ADD COLUMN `qmsBomId` VARCHAR(64) NULL;

-- CreateTable
CREATE TABLE `route_template` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `createdBy` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `route_template_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `route_template_step` (
    `id` VARCHAR(191) NOT NULL,
    `templateId` VARCHAR(191) NOT NULL,
    `seq` INTEGER NOT NULL,
    `processId` VARCHAR(64) NOT NULL,
    `mode` ENUM('SELF', 'IN_PLANT_OUTSOURCE', 'EXTERNAL_OUTSOURCE') NOT NULL,
    `supplierId` VARCHAR(64) NULL,
    `defaultDays` INTEGER NULL,

    UNIQUE INDEX `route_template_step_templateId_seq_key`(`templateId`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `part_workOrderNumber_qmsBomId_key` ON `part`(`workOrderNumber`, `qmsBomId`);

-- AddForeignKey
ALTER TABLE `route_template_step` ADD CONSTRAINT `route_template_step_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `route_template`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

