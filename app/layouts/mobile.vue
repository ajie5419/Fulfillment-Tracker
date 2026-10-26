<script setup lang="ts">
// 手机端主题（前端改版第二轮）：Vant 变量覆盖、卡片、状态色，见 assets/mobile.css
import '~/assets/mobile.css'

// 生产管理重设计（zhao 10-26）：底部 4 个页签 提醒 / 生产 / 签收 / 异常，人人都有。
// 原"在途""发出"并进"生产"（能开工 / 在做 / 在外）；发出登记页 /m/send 从"生产"里厂外工序的"发出"按钮进。
// "生产"不按角色隐藏：原"在途"人人可看，工序负责人可能在任何部门（要能点完工），没有操作权限的人只看到卡片、没有按钮。
</script>

<template>
  <div class="ft-m">
    <slot />
    <van-tabbar route placeholder safe-area-inset-bottom>
      <van-tabbar-item to="/m" icon="bell" replace>提醒</van-tabbar-item>
      <van-tabbar-item to="/m/work" icon="underway-o" replace>生产</van-tabbar-item>
      <van-tabbar-item to="/m/releases" icon="certificate" replace>签收</van-tabbar-item>
      <van-tabbar-item to="/m/issues" icon="warning-o" replace>异常</van-tabbar-item>
    </van-tabbar>
  </div>
</template>
