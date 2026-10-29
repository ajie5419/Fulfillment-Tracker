-- 发放单作废时，已下发工艺需要独立的“修改中”状态。
ALTER TABLE `drawing_task` MODIFY `processStatus` ENUM('NONE', 'DRAFTING', 'ISSUED', 'REVISING') NOT NULL DEFAULT 'NONE';
