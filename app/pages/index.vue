<script setup lang="ts">
const { data, pending } = useReminders()
const levelColor = { RED: 'red', YELLOW: 'orange', REMIND: 'blue' } as const
const levelText = { RED: '红色', YELLOW: '黄色', REMIND: '提醒' } as const
</script>

<template>
  <a-card title="我的提醒" :loading="pending">
    <template #extra>
      <a-badge :count="data?.unread ?? 0" />
    </template>
    <a-empty v-if="!data?.items.length" description="暂时没有提醒" />
    <a-list v-else :data-source="data.items" item-layout="horizontal">
      <template #renderItem="{ item }">
        <a-list-item>
          <a-tag :color="levelColor[item.level as keyof typeof levelColor]">{{ levelText[item.level as keyof typeof levelText] }}</a-tag>
          <span :style="{ fontWeight: item.readAt ? 'normal' : 600 }">{{ item.title }}</span>
          <template #extra>{{ new Date(item.createdAt).toLocaleString('zh-CN') }}</template>
        </a-list-item>
      </template>
    </a-list>
  </a-card>
</template>
