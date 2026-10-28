<script setup lang="ts">
defineProps<{ loading: boolean; finished: boolean; error: boolean; loaded: number; total: number }>()
defineEmits<{ load: [] }>()
</script>

<template>
  <van-list :loading="loading" :finished="finished" :error="error" :immediate-check="false"
    error-text="加载失败，点击重试" finished-text="已全部加载" @load="$emit('load')"
    @update:error="(value: boolean) => { if (!value) $emit('load') }">
    <slot />
  </van-list>
  <div v-if="loaded && !finished" class="ft-load-more">
    <span>已加载 {{ loaded }} / {{ total }} 项</span>
    <van-button size="small" plain :loading="loading" @click="$emit('load')">{{ error ? '重试' : '加载更多' }}</van-button>
  </div>
</template>

<style scoped>
.ft-load-more { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 12px; color: var(--ft-text-2); font-size: 13px; }
</style>
