# Changelog

## 0.1.0 (2026-10-31)


### Features

* **bom:** 图纸发放时附 BOM 自动建工件，QMS BOM 按图号关联；新增工艺部 ([#34](https://github.com/ajie5419/Fulfillment-Tracker/issues/34)) ([16d2f5e](https://github.com/ajie5419/Fulfillment-Tracker/commit/16d2f5e0f9c43ab14242471b10c302a892df94a9))
* **calendar:** 项目日历按周/月统计计划与实际完成台数 ([#26](https://github.com/ajie5419/Fulfillment-Tracker/issues/26)) ([1fb4623](https://github.com/ajie5419/Fulfillment-Tracker/commit/1fb46234757cad0d13e8209e6c7e951639726dfb))
* **calendar:** 项目日历改为日历/列表两种显示，可切换 ([#28](https://github.com/ajie5419/Fulfillment-Tracker/issues/28)) ([0c768ee](https://github.com/ajie5419/Fulfillment-Tracker/commit/0c768ee67ee1ec712999d8332a7727c92d77104c))
* **drawings:** 术语「出图任务」更名为「设计任务」 ([#25](https://github.com/ajie5419/Fulfillment-Tracker/issues/25)) ([d3d5e6d](https://github.com/ajie5419/Fulfillment-Tracker/commit/d3d5e6d6ef0a44352eff5f7aa1f9c4f9856444b6))
* **plan:** 总计划支持前置节点、阶段、子节点、开始日与甘特图 ([#32](https://github.com/ajie5419/Fulfillment-Tracker/issues/32)) ([5054bc6](https://github.com/ajie5419/Fulfillment-Tracker/commit/5054bc6067feaa3339c2649609080206aa91d66e))
* **plan:** 汇总行与影响范围、项目计划大纲分级、新增部门计划页 ([#33](https://github.com/ajie5419/Fulfillment-Tracker/issues/33)) ([940c5c7](https://github.com/ajie5419/Fulfillment-Tracker/commit/940c5c716b437abcda5b7b93b4f8c7ebf4a90db6))
* **plan:** 部门计划二次分解，项目计划单独成菜单页 ([#31](https://github.com/ajie5419/Fulfillment-Tracker/issues/31)) ([c888745](https://github.com/ajie5419/Fulfillment-Tracker/commit/c8887459ce0112ee819f3fdc65e2efd7c9aba17f))
* **process:** 新增工艺模块——按部件跟踪料单、工艺状态 ([#41](https://github.com/ajie5419/Fulfillment-Tracker/issues/41)) ([c60b724](https://github.com/ajie5419/Fulfillment-Tracker/commit/c60b724e8341dc2ff7c616bce940ca52a8a61324))
* **production:** 全局搜索、留言@人、车间看板、工件时间线和关联记录数 ([#37](https://github.com/ajie5419/Fulfillment-Tracker/issues/37)) ([31b02f9](https://github.com/ajie5419/Fulfillment-Tracker/commit/31b02f976f7c7c74a4b80680976a291abe40a0be))
* **production:** 手机端完工、厂内工序逾期预警 W10、图纸建工件后提醒排工序 ([#35](https://github.com/ajie5419/Fulfillment-Tracker/issues/35)) ([d1f5598](https://github.com/ajie5419/Fulfillment-Tracker/commit/d1f559873b56a424074e6b72d2402031d10b2ceb))
* **production:** 生产管理补全——派工到班组、部分完工/报废、应开工日、随件发料 ([#36](https://github.com/ajie5419/Fulfillment-Tracker/issues/36)) ([f79dac1](https://github.com/ajie5419/Fulfillment-Tracker/commit/f79dac1f834756cd42b8ad449753a4b8f2ec14c6))
* **production:** 生产管理重设计第一批（生产调度 / 工序编排 / 外协 / 手机端生产） ([#38](https://github.com/ajie5419/Fulfillment-Tracker/issues/38)) ([332aba0](https://github.com/ajie5419/Fulfillment-Tracker/commit/332aba0904b2722a6072cb7a78d3df74953cc83d))
* **production:** 生产管理重设计第二批（班组长账号 / 统一"谁负责" / 班组长开工完工） ([#39](https://github.com/ajie5419/Fulfillment-Tracker/issues/39)) ([b4a8022](https://github.com/ajie5419/Fulfillment-Tracker/commit/b4a80229b74e05c77374f9afdf0d49b704aa873e))
* **ui:** adopt finalized design system across desktop and mobile ([#24](https://github.com/ajie5419/Fulfillment-Tracker/issues/24)) ([798b93f](https://github.com/ajie5419/Fulfillment-Tracker/commit/798b93fd15b73e9f5b052527e2ea17c2fb973d10))
* **ui:** 前端改版第二轮：工作台卡片流、风险页、部门工作台统计卡、手机端卡片化 ([#21](https://github.com/ajie5419/Fulfillment-Tracker/issues/21)) ([fd4adb7](https://github.com/ajie5419/Fulfillment-Tracker/commit/fd4adb71ef50c05921830b97982cb6e12057d0c2))
* **ui:** 左上角换成通联 TOLIAN 公司标志，并加浏览器标签图标 ([#27](https://github.com/ajie5419/Fulfillment-Tracker/issues/27)) ([98e1b68](https://github.com/ajie5419/Fulfillment-Tracker/commit/98e1b687f3c64060a24aa1b7de984eda1d2cf4cc))
* **ui:** 总计划并进工单详情，手机端待办分组共用规则，已完工工单默认隐藏 ([#30](https://github.com/ajie5419/Fulfillment-Tracker/issues/30)) ([56d0584](https://github.com/ajie5419/Fulfillment-Tracker/commit/56d0584669d685cd5ade80e9187e6388b8537147))
* **ui:** 领导总览并入项目总览，去掉工单详情入口页，路线模板挪进设置 ([#29](https://github.com/ajie5419/Fulfillment-Tracker/issues/29)) ([b71236a](https://github.com/ajie5419/Fulfillment-Tracker/commit/b71236a84abb22e1f0db1cf354c391b64431785f))
* **work-order:** 履约新建/修改/取消工单（写入 QMS 工单库） ([#42](https://github.com/ajie5419/Fulfillment-Tracker/issues/42)) ([98bd53b](https://github.com/ajie5419/Fulfillment-Tracker/commit/98bd53b026af4c5957a86023e51b2abd59431f1a))
* 全流程走查30条问题修复＋料单开工前提＋采购计划下发＋发放前置 ([#53](https://github.com/ajie5419/Fulfillment-Tracker/issues/53)) ([084c182](https://github.com/ajie5419/Fulfillment-Tracker/commit/084c182a5d291b6fe0b2bee60e3434063e964d8d))
* 状态监控（在制停滞计算＋W11 停滞预警＋看板监控区） ([#56](https://github.com/ajie5419/Fulfillment-Tracker/issues/56)) ([3f89555](https://github.com/ajie5419/Fulfillment-Tracker/commit/3f895554369e8a0b989a5f921712da6b4132c6ec))
* 项目总览改版（驾驶舱拆分＋工单状态胶囊＋停滞红线计数） ([#58](https://github.com/ajie5419/Fulfillment-Tracker/issues/58)) ([23af19b](https://github.com/ajie5419/Fulfillment-Tracker/commit/23af19bcf89e004e90c574b0379ca993e97ddb5c))


### Bug Fixes

* **auth:** revoke sessions for unavailable QMS accounts ([#45](https://github.com/ajie5419/Fulfillment-Tracker/issues/45)) ([bfee3d3](https://github.com/ajie5419/Fulfillment-Tracker/commit/bfee3d30c88ec0cb7d47cb7a6174db71078f79f8))
* **issues:** include matches beyond the first read batch ([#48](https://github.com/ajie5419/Fulfillment-Tracker/issues/48)) ([bd121c0](https://github.com/ajie5419/Fulfillment-Tracker/commit/bd121c071271fe3d81854c8765839aafc6776026))
* **kitting:** withdraw readiness for rejected parts ([#46](https://github.com/ajie5419/Fulfillment-Tracker/issues/46)) ([292d732](https://github.com/ajie5419/Fulfillment-Tracker/commit/292d732aa4ba3a76e7c698bdc29aa44128894cf8))
* **production:** 班组长判断在事务内读可见范围、换班组长事务超时 ([#51](https://github.com/ajie5419/Fulfillment-Tracker/issues/51)) ([9bc5d55](https://github.com/ajie5419/Fulfillment-Tracker/commit/9bc5d553a344dd4c0ca1db91e379944033ef345b))
* **purchases:** share server pagination across lists and options ([#50](https://github.com/ajie5419/Fulfillment-Tracker/issues/50)) ([238d90e](https://github.com/ajie5419/Fulfillment-Tracker/commit/238d90e526d20bf90d1ebc6edd65d7bcf804de5c))
* **sync:** fence writes after lease expiry ([#49](https://github.com/ajie5419/Fulfillment-Tracker/issues/49)) ([c7d59ac](https://github.com/ajie5419/Fulfillment-Tracker/commit/c7d59ac768abef1092548d947cd67249ec7211f3))
* **todos:** enforce ownership and recipient scope on transfers ([#44](https://github.com/ajie5419/Fulfillment-Tracker/issues/44)) ([e131eeb](https://github.com/ajie5419/Fulfillment-Tracker/commit/e131eeb1cc295f93243d017014f2b6228ed8533b))
* **ui:** [P0] 修正图表几何刻度精度并拆分多阶段/阻塞标签语义色 ([#60](https://github.com/ajie5419/Fulfillment-Tracker/issues/60)) ([6b97163](https://github.com/ajie5419/Fulfillment-Tracker/commit/6b97163ad0dac2bc746abb9043401fb94a335a0d))
* **ui:** [P1] 统一页面标题层级、Bento 卡片物理态与业务表格规范 ([#61](https://github.com/ajie5419/Fulfillment-Tracker/issues/61)) ([7124e3c](https://github.com/ajie5419/Fulfillment-Tracker/commit/7124e3c82985ea00d9461fb7fe2399d7f540b6ec))
* **ui:** [P2] 完善无障碍键盘交互、窄屏抽屉侧栏与手机端 /m 首屏体验 ([#62](https://github.com/ajie5419/Fulfillment-Tracker/issues/62)) ([a6e3d24](https://github.com/ajie5419/Fulfillment-Tracker/commit/a6e3d24587dd11206f2689046084bb0484bc53e3))
* **ui:** prevent stale record actions after selection changes ([#47](https://github.com/ajie5419/Fulfillment-Tracker/issues/47)) ([f86e6a3](https://github.com/ajie5419/Fulfillment-Tracker/commit/f86e6a39c834158ba01dfee08448dd4ba49f1bad))
* **work-order:** QMS 404 判断与新建后刷新看板 ([#43](https://github.com/ajie5419/Fulfillment-Tracker/issues/43)) ([b668a9d](https://github.com/ajie5419/Fulfillment-Tracker/commit/b668a9da0b2751dd29078b8345b064c899bfbebc))
* 修复弹窗内日期手打保存丢失并统一日期输入 ([#55](https://github.com/ajie5419/Fulfillment-Tracker/issues/55)) ([9aab348](https://github.com/ajie5419/Fulfillment-Tracker/commit/9aab3487726e52726af7a11d44ec8a278b70f7e9))
* 采购计划全部转入后再下发不产生死待办 ([#54](https://github.com/ajie5419/Fulfillment-Tracker/issues/54)) ([857e102](https://github.com/ajie5419/Fulfillment-Tracker/commit/857e1020f04dfd942680e2dd3243a2828fd16ab4))
