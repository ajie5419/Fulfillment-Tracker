<template>
  <div class="mobile">
    <slot />
  </div>
</template>

<style scoped>
.mobile { min-height: 100vh; max-width: 640px; margin: 0 auto; background: #f7f8fa; padding-bottom: env(safe-area-inset-bottom); }
</style>
