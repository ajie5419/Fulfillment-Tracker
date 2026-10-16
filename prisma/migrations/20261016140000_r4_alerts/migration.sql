-- R4 预警与提醒：通知对象表、提醒防重复的唯一约束、默认阈值

-- CreateTable
CREATE TABLE `notify_role` (
    `id` VARCHAR(191) NOT NULL,
    `role` ENUM('OUTSOURCE_COORDINATOR', 'DEPT_HEAD', 'PROJECT_DEPT_HEAD', 'LEADER') NOT NULL,
    `userId` VARCHAR(64) NOT NULL,
    `department` VARCHAR(191) NULL,

    INDEX `notify_role_role_idx`(`role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable：后台任务租约锁
CREATE TABLE `job_lock` (
    `name` VARCHAR(40) NOT NULL,
    `lockedUntil` DATETIME(3) NOT NULL,
    `holder` VARCHAR(64) NULL,

    PRIMARY KEY (`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `reminder_alertId_level_userId_key` ON `reminder`(`alertId`, `level`, `userId`);

-- 默认阈值（方案 6.1），已有的不覆盖。W3 的 remindHours = 承诺返回日前 48 小时（2 天）
INSERT IGNORE INTO `threshold` (`rule`, `remindHours`, `yellowDays`, `redDays`) VALUES
    ('W1', 4, 1, 3),
    ('W2', NULL, 2, 4),
    ('W3', 48, 1, 3);
