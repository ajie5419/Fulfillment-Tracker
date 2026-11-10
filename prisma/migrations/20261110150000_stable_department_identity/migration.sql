-- Preserve unknown legacy departments for explicit mapping in settings.
-- Known business identities must no longer depend on their display labels.
UPDATE `notify_role`
SET `department` = CASE `department`
  WHEN '技术部' THEN 'TECH'
  WHEN '工艺部' THEN 'PROCESS'
  WHEN '采购部' THEN 'PURCHASE'
  WHEN '生产部' THEN 'PRODUCTION'
  WHEN '质量部' THEN 'QUALITY'
  WHEN '财务部' THEN 'FINANCE'
  WHEN '项目部' THEN 'PROJECT'
  ELSE `department`
END
WHERE `role` = 'DEPT_HEAD';
