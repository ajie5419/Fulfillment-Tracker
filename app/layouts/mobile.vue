<script setup lang="ts">
// 手机端主题（前端改版第二轮）：Vant 变量覆盖、卡片、状态色，见 assets/mobile.css
import '~/assets/mobile.css'

// "发出"页签只给生产部、外协专员、管理员显示（权限方案 R13）；其余 4 个页签人人都有
const { data: me } = await useMe()
</script>

<template>
  <div class="ft-m">
    <slot />
    <van-tabbar route placeholder safe-area-inset-bottom>
      <van-tabbar-item to="/m" icon="bell" replace>提醒</van-tabbar-item>
      <van-tabbar-item to="/m/transit" icon="logistics" replace>在途</van-tabbar-item>
      <van-tabbar-item v-if="me?.can.mobileSend" to="/m/send" icon="send-gift-o" replace>发出</van-tabbar-item>
      <van-tabbar-item to="/m/releases" icon="certificate" replace>签收</van-tabbar-item>
      <van-tabbar-item to="/m/issues" icon="warning-o" replace>异常</van-tabbar-item>
    </van-tabbar>
  </div>
</template>
