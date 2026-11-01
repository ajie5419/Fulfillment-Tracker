/** 单个文件的大小上限（字节），前后端共用。 */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_BOM_BYTES = 5 * 1024 * 1024

/** 单次 multipart 请求的文件数量上限；附件可分批上传。 */
export const MAX_FILES_PER_REQUEST = 3

/** 业务记录允许绑定的总数，独立于单次上传数量。 */
export const MAX_ISSUE_PHOTOS = 3
export const MAX_RELEASE_ATTACHMENTS = 5
