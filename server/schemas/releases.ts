/** 发放签收接口的 zod 片段 */
import { z } from 'zod'
import { MAX_ATTACHMENTS, MAX_RECIPIENTS } from '../services/releases/constants'

export const releaseType = z.enum(['DRAWING', 'CHANGE', 'PROCESS'], { message: '请选择类型' })
const id = z.string().min(1).max(191)
const notifyRole = z.enum(['OUTSOURCE_COORDINATOR', 'DEPT_HEAD', 'PROJECT_DEPT_HEAD', 'LEADER'])

export const newReleaseBody = z
  .object({
    type: releaseType,
    workOrderNumber: z.string().min(1, '请选择工单').max(64),
    partIds: z.array(id).max(100, '关联工件最多 100 个').default([]),
    version: z.string().trim().max(64, '版本号最多 64 字').nullish(),
    description: z.string().trim().min(1, '请填写说明').max(2000, '说明最多 2000 字'),
    attachmentIds: z.array(z.string().regex(/^[a-f0-9]{32}$/, '附件无效')).max(MAX_ATTACHMENTS, `附件最多 ${MAX_ATTACHMENTS} 个`).default([]),
    /** 按人选 */
    userIds: z.array(z.string().min(1).max(64)).max(MAX_RECIPIENTS).default([]),
    /** 按"部门 + 角色"选：只填部门 = 该部门全部人员；只填角色 = 担任该角色的人 */
    groups: z
      .array(z.object({ department: z.string().trim().max(191).nullish(), role: notifyRole.nullish() }).strict())
      .max(20)
      .default([]),
    /** 从设计任务一键发放（R11） */
    drawingTaskId: z.string().min(1).max(191).nullish(),
    /** 图纸发放单附的 BOM 表（先 POST /api/uploads?kind=bom 上传） */
    bomFileId: z.string().regex(/^[a-f0-9]{32}$/, 'BOM 表无效').nullish(),
  })
  .strict()

export const rejectBody = z.object({ reason: z.string().trim().min(1, '请填写拒收原因').max(500, '原因最多 500 字') }).strict()
export const confirmBody = z.object({ note: z.string().trim().max(500, '最多 500 字').nullish() }).strict()
