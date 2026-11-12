<script setup lang="ts">
/**
 * 责任人微头像 + 姓名组件（Brick 风格，全局复用）：
 * 按姓名哈希稳定映射到 base.css 的 5 套柔和色阶（--ft-av-1..5），未指定时退化为中性灰。
 */
const props = withDefaults(
  defineProps<{
    name?: string | null
    fallback?: string
    muted?: boolean
  }>(),
  { name: null, fallback: '未指派', muted: false },
)

const displayText = computed(() => props.name?.trim() || props.fallback)
const initial = computed(() => {
  const s = props.name?.trim()
  if (!s) return '—'
  // 若带括号如"技术部（张工）"，优先取真实姓氏首字
  const clean = s.replace(/^.*（/, '').replace(/）.*$/, '').trim() || s
  return clean.charAt(0).toUpperCase()
})

const paletteIndex = computed(() => {
  const s = props.name?.trim()
  if (!s || props.muted) return 0
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0
  }
  return (hash % 5) + 1
})
</script>

<template>
  <span class="ft-user-chip" :class="{ 'is-muted': !name || muted }" :title="displayText">
    <span class="av" :class="`av-${paletteIndex}`" aria-hidden="true">{{ initial }}</span>
    <span class="name">{{ displayText }}</span>
  </span>
</template>

<style scoped>
.ft-user-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  color: var(--ft-text-2);
  font-size: 12.5px;
  vertical-align: middle;
}
.ft-user-chip.is-muted {
  color: var(--ft-text-3);
}
.av {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  font-size: 10.5px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  line-height: 1;
}
.av-0 {
  background: var(--ft-fill);
  border: 1px solid var(--ft-border);
  color: var(--ft-text-3);
}
.av-1 { background: var(--ft-av-1-bg); color: var(--ft-av-1-text); }
.av-2 { background: var(--ft-av-2-bg); color: var(--ft-av-2-text); }
.av-3 { background: var(--ft-av-3-bg); color: var(--ft-av-3-text); }
.av-4 { background: var(--ft-av-4-bg); color: var(--ft-av-4-text); }
.av-5 { background: var(--ft-av-5-bg); color: var(--ft-av-5-text); }

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
