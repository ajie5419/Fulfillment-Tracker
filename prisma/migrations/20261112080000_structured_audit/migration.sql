CREATE TABLE `audit_log` (
  `id` VARCHAR(191) NOT NULL,
  `requestId` VARCHAR(64) NULL,
  `actorId` VARCHAR(64) NULL,
  `action` VARCHAR(64) NOT NULL,
  `entityType` VARCHAR(64) NOT NULL,
  `entityId` VARCHAR(191) NOT NULL,
  `metadata` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `audit_log_entityType_entityId_createdAt_idx` (`entityType`, `entityId`, `createdAt`),
  INDEX `audit_log_requestId_idx` (`requestId`),
  INDEX `audit_log_createdAt_id_idx` (`createdAt`, `id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
