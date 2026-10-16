<script setup lang="ts">
definePageMeta({ layout: 'mobile' })
const { data: me } = useMe()
const { data, pending } = useReminders()
const levelType = { RED: 'danger', YELLOW: 'warning', REMIND: 'primary' } as const
</script>

<template>
  <div>
    <van-nav-bar title="我的提醒" />
    <van-cell-group inset class="me">
      <van-cell :title="me?.name ?? ''" :label="me?.department ?? ''">
        <template #value>
          <van-badge :content="data?.unread || ''">未读</van-badge>
        </template>
      </van-cell>
    </van-cell-group>
    <van-loading v-if="pending" class="center" />
    <van-empty v-else-if="!data?.items.length" description="暂时没有提醒" />
    <van-cell-group v-else inset>
      <van-cell v-for="item in data.items" :key="item.id" :title="item.title" :label="new Date(item.createdAt).toLocaleString('zh-CN')">
        <template #icon>
          <van-tag :type="levelType[item.level]" class="tag">{{ item.level === 'RED' ? '红' : item.level === 'YELLOW' ? '黄' : '提醒' }}</van-tag>
        </template>
      </van-cell>
    </van-cell-group>
  </div>
</template>

<style scoped>
.me { margin: 12px 0; }
.center { display: flex; justify-content: center; padding: 32px; }
.tag { margin-right: 8px; align-self: center; }
</style>
