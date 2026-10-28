<script setup lang="ts">
withDefaults(defineProps<{ page: number; pageSize: number; total: number; loading?: boolean }>(), { loading: false })
defineEmits<{ change: [page: number, pageSize: number] }>()
</script>

<template>
  <div class="ft-list-pager">
    <a-pagination :current="page" :page-size="pageSize" :total="total" :disabled="loading"
      :page-size-options="['20', '50', '100']" show-size-changer show-quick-jumper
      :show-total="(n: number) => `共 ${n} 项`" @change="(p: number, size: number) => $emit('change', p, size)" />
  </div>
</template>

<style scoped>
.ft-list-pager { display: flex; justify-content: flex-end; flex-wrap: wrap; margin-top: 16px; }
</style>
