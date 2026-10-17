-- R5 异常闭环与看板：异常幂等键、上传文件表、每日汇总防重复、W4 默认阈值

-- 异常：系统来源的幂等键（"QMS:<报检 ID>"、"ALERT:<预警 ID>"），手工上报为 NULL
ALTER TABLE `issue` ADD COLUMN `sourceKey` VARCHAR(120) NULL;
CREATE UNIQUE INDEX `issue_sourceKey_key` ON `issue`(`sourceKey`);
CREATE INDEX `issue_refType_refId_idx` ON `issue`(`refType`, `refId`);
CREATE INDEX `issue_status_idx` ON `issue`(`status`);

-- 提醒：每日汇总（kind = DIGEST）的正文与同人同日唯一键
ALTER TABLE `reminder` ADD COLUMN `body` TEXT NULL,
    ADD COLUMN `dedupeKey` VARCHAR(120) NULL,
    ADD COLUMN `kind` VARCHAR(20) NULL;
CREATE UNIQUE INDEX `reminder_dedupeKey_key` ON `reminder`(`dedupeKey`);

-- 上传文件（异常照片）
CREATE TABLE `upload_file` (
    `id` VARCHAR(64) NOT NULL,
    `storedName` VARCHAR(80) NOT NULL,
    `mime` VARCHAR(40) NOT NULL,
    `size` INTEGER NOT NULL,
    `uploaderId` VARCHAR(64) NOT NULL,
    `issueId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `upload_file_issueId_idx`(`issueId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- W4 异常超期默认阈值（方案 6.1）：待受理 / 超期 1 天黄，超期 3 天红；没有"提醒"一级。已有的不覆盖
INSERT IGNORE INTO `threshold` (`rule`, `remindHours`, `yellowDays`, `redDays`) VALUES
    ('W4', NULL, 1, 3);
