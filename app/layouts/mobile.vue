<script setup lang="ts">
// "发出"页签只给生产部、外协专员、管理员显示（权限方案 R13）；其余 4 个页签人人都有
const { data: me } = await useMe()
</script>

<template>
  <div class="mobile">
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

<style scoped>
.mobile { min-height: 100vh; max-width: 640px; margin: 0 auto; background: #f7f8fa; }
</style>
