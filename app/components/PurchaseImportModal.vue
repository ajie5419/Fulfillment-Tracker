<script setup lang="ts">
/**
 * Excel 导入关键物料（R10）：下载模板 → 填好 → 上传。逐行校验，有任何一行不对整批不导入，列出每行的问题，改好后重新上传。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; done: [] }>()

const file = ref<File | null>(null)
const uploading = ref(false)
const result = ref<{ imported: number; rows: number; errors: { row: number; messages: string[] }[]; warnings?: { row: number; messages: string[] }[] } | null>(null)

watch(
  () => props.open,
  (open) => {
    if (open) {
      file.value = null
      result.value = null
    }
  },
)

function beforeUpload(f: File) {
  if (f.size > 2 * 1024 * 1024) {
    message.error('文件不能超过 2MB')
    return false
  }
  file.value = f
  result.value = null
  return false // 不自动上传
}

async function submit() {
  if (!file.value) return message.warning('请选择 Excel 文件')
  uploading.value = true
  try {
    const form = new FormData()
    form.append('file', file.value, file.value.name || 'import.xlsx')
    const send = clientRequest
    result.value = await send('/api/purchases/import', { method: 'POST', body: form })
    if (!result.value.errors.length) {
      message.success(`已导入 ${result.value.imported} 项`)
      emit('done')
    }
  } catch (e) {
    message.error(apiError(e))
  } finally {
    uploading.value = false
  }
}

const errorColumns = [
  { title: 'Excel 行号', dataIndex: 'row', width: 100 },
  { title: '问题', key: 'messages' },
]
</script>

<template>
  <a-modal :open="open" title="Excel 导入关键物料" width="720px" :footer="null" @cancel="emit('close')">
    <a-steps direction="vertical" size="small" :current="-1" class="steps">
      <a-step title="下载模板"><template #description><a href="/api/purchases/template" download>关键物料导入模板.xlsx</a>（第二张表是填写说明）</template></a-step>
      <a-step title="填写" description="一行一项关键物料：工单号、物料名称、数量、需求日必填；供应商名称与 QMS 一致时自动关联；“总计划节点”填该工单总计划里的节点名称（对不上时留空照常导入）" />
      <a-step title="上传" description="逐行校验；有任何一行不对整批不导入，按提示改好后重新上传" />
    </a-steps>
    <a-space>
      <a-upload :before-upload="beforeUpload" :show-upload-list="false" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
        <a-button>选择文件</a-button>
      </a-upload>
      <span v-if="file">{{ file.name }}</span>
      <a-button type="primary" :disabled="!file" :loading="uploading" @click="submit">导入</a-button>
    </a-space>
    <template v-if="result">
      <template v-if="!result.errors.length">
        <a-alert type="success" show-icon class="result" :message="`已导入 ${result.imported} 项`" />
        <template v-if="result.warnings?.length">
          <a-alert type="warning" show-icon class="result" :message="`${result.warnings.length} 行的总计划节点没挂上（已照常导入，节点留空）`" description="到采购到货页编辑这些行，选“所属总计划节点”" />
          <a-table :columns="errorColumns" :data-source="result.warnings" row-key="row" size="small" :pagination="{ pageSize: 20, hideOnSinglePage: true }">
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'messages'">{{ record.messages.join('；') }}</template>
            </template>
          </a-table>
        </template>
      </template>
      <template v-else>
        <a-alert type="error" show-icon class="result" :message="`${result.errors.length} 行有问题，整批没有导入（共 ${result.rows} 行）`" description="改好后重新上传整个文件即可，不会重复导入" />
        <a-table :columns="errorColumns" :data-source="result.errors" row-key="row" size="small" :pagination="{ pageSize: 20, hideOnSinglePage: true }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'messages'">{{ record.messages.join('；') }}</template>
          </template>
        </a-table>
      </template>
    </template>
  </a-modal>
</template>

<style scoped>
.steps { margin-bottom: 16px; }
.result { margin: 16px 0 8px; }
</style>
