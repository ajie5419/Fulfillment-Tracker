-- R13 权限：QMS 部门 → 业务部门对照（设置页"部门对照"维护）

-- CreateTable
CREATE TABLE `dept_mapping` (
    `qmsDepartmentId` VARCHAR(64) NOT NULL,
    `businessDept` ENUM('TECH', 'PURCHASE', 'PRODUCTION', 'QUALITY', 'FINANCE', 'PROJECT') NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`qmsDepartmentId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
