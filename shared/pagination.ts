export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 100

export interface PageResult<T> {
  rows: T[]
  total: number
  page: number
  pageSize: number
}
