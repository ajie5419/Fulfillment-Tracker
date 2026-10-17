<template>
  <div class="mobile">
    <slot />
    <van-tabbar route placeholder safe-area-inset-bottom>
      <van-tabbar-item to="/m" icon="bell" replace>提醒</van-tabbar-item>
      <van-tabbar-item to="/m/transit" icon="logistics" replace>在途</van-tabbar-item>
      <van-tabbar-item to="/m/send" icon="send-gift-o" replace>发出</van-tabbar-item>
      <van-tabbar-item to="/m/issues" icon="warning-o" replace>异常</van-tabbar-item>
    </van-tabbar>
  </div>
</template>

<style scoped>
.mobile { min-height: 100vh; max-width: 640px; margin: 0 auto; background: #f7f8fa; }
</style>
