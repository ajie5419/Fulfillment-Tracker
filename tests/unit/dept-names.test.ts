/**
 * 防回归：6 个业务部门的名称只在 shared/business-depts.ts 定义一次，其余地方都从它派生（服务端经 auth/departments.ts）。
 *
 * 扫 app/、server/ 下的 .ts / .vue，找"整个字符串就是部门名"的字面量（'技术部'、"采购部"、`生产部`）——
 * 这正是复制一份名称去比对 / 做下拉的写法。句子里提到部门（"不选 = 技术部负责人"、报错文案）不算，不用列白名单。
 * 注释行（// 、* 、/* 、<!-- 开头）跳过。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BUSINESS_DEPT_NAME } from '../../shared/business-depts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const NAMES = Object.values(BUSINESS_DEPT_NAME)
const LITERAL = new RegExp(`(['"\`])(${NAMES.join('|')})\\1`)
const COMMENT = /^\s*(\/\/|\*|\/\*|<!--)/

/** 整个文件放行 */
const ALLOW_FILES = new Set([
  'server/services/dev/demo.ts', // 演示数据：造 QMS 部门、部门负责人，本来就是"外部数据"
])
/** 放行的具体行（文件 + 行内片段），写明原因 */
const ALLOW_LINES: { file: string; contains: string; why: string }[] = [
  { file: 'app/pages/settings.vue', contains: '部门名称正好是"技术部""生产部"等的按名称算', why: '部门对照页的说明文字，举例用' },
]

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|vue)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('业务部门名称只有一个来源', () => {
  it('shared/business-depts.ts 是 6 个名称', () => {
    expect(NAMES).toEqual(['技术部', '采购部', '生产部', '质量部', '财务部', '项目部'])
  })

  it('app/、server/ 里没有部门名称的字符串字面量（应从 BUSINESS_DEPT_NAME 派生）', () => {
    const hits: string[] = []
    const files = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'server'))]
    expect(files.length).toBeGreaterThan(50) // 防止路径写错时什么都没扫就通过
    for (const abs of files) {
      const file = relative(ROOT, abs).split('\\').join('/')
      if (ALLOW_FILES.has(file)) continue
      readFileSync(abs, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (COMMENT.test(line) || !LITERAL.test(line)) return
          if (ALLOW_LINES.some((a) => a.file === file && line.includes(a.contains))) return
          hits.push(`${file}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(hits).toEqual([])
  })

  it('白名单里的行都还在（失效的及时删掉）', () => {
    for (const a of ALLOW_LINES) expect(readFileSync(join(ROOT, a.file), 'utf8'), a.why).toContain(a.contains)
  })
})
