<script setup lang="ts">
const { data: me } = await useMe()
const route = useRoute()
const menu = computed(() => [
  { key: '/', label: '我的提醒' },
  { key: '/parts', label: '工件与工序链' },
  { key: '/unmatched', label: '待确认匹配' },
  ...(me.value?.devTools ? [{ key: '/dev', label: '演示工具' }] : []),
])
const selected = computed(() => [menu.value.find((m) => m.key !== '/' && route.path.startsWith(m.key))?.key ?? '/'])
</script>

<template>
  <a-layout style="min-height: 100vh">
    <a-layout-header class="header">
      <span class="brand">项目履约</span>
      <a-menu theme="dark" mode="horizontal" :selected-keys="selected" class="menu">
        <a-menu-item v-for="m in menu" :key="m.key"><NuxtLink :to="m.key">{{ m.label }}</NuxtLink></a-menu-item>
      </a-menu>
      <span v-if="me" class="user">
        {{ me.name }}<template v-if="me.department"> · {{ me.department }}</template>
        <a-button type="link" size="small" @click="logout">退出</a-button>
      </span>
    </a-layout-header>
    <a-layout-content class="content">
      <slot />
    </a-layout-content>
  </a-layout>
</template>

<style scoped>
.header { display: flex; align-items: center; gap: 24px; padding: 0 24px; }
.brand { color: #fff; font-weight: 600; font-size: 16px; }
.menu { flex: 1; }
.user { color: rgba(255, 255, 255, 0.85); }
.content { padding: 24px; }
</style>
