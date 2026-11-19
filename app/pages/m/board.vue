<script setup lang="ts">
definePageMeta({ layout: 'mobile' })
</script>

<template>
  <div>
    <van-nav-bar title="项目总览" left-text="工作台" left-arrow @click-left="navigateTo('/m')" />
    <div class="m-list"><BoardOrderDirectory mobile /></div>
    <div class="m-foot" />
  </div>
</template>
