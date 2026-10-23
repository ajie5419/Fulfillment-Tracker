-- 总计划子节点（10-22）：节点可以挂在上级节点下面（只一层）；模板节点记上级的顺序号
-- AlterTable
ALTER TABLE `plan_node` ADD COLUMN `parentId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `plan_template_node` ADD COLUMN `parentSeq` INTEGER NULL;

-- CreateIndex
CREATE INDEX `plan_node_parentId_idx` ON `plan_node`(`parentId`);

-- AddForeignKey
ALTER TABLE `plan_node` ADD CONSTRAINT `plan_node_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `plan_node`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

