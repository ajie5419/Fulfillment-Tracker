-- W10 厂内工序逾期未完（10-26，借鉴 ERPNext 评估后补的缺口）：自制 / 厂内外协开工后超过要求完成日，之前没有任何预警
ALTER TABLE `alert` MODIFY `rule` ENUM('W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10') NOT NULL;
ALTER TABLE `threshold` MODIFY `rule` ENUM('W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10') NOT NULL;

-- 默认阈值：要求完成日前 2 天提醒（48 小时），超期 1 天黄、3 天红（与 W3 相同）；已有的不覆盖
INSERT IGNORE INTO `threshold` (`rule`, `remindHours`, `yellowDays`, `redDays`) VALUES ('W10', 48, 1, 3);
