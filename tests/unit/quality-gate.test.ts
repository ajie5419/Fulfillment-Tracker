import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { analyzeProject, compareBaseline } from '../../scripts/quality-gate.mjs'

const roots: string[] = []
function project(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ft-quality-'))
  roots.push(root)
  for (const dir of ['app', 'server', 'shared']) mkdirSync(join(root, dir))
  writeFiles(root, files)
  return root
}
function writeFiles(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('质量门禁的统计口径', () => {
  it('只计语法节点，忽略注释/字符串/逻辑非/声明感叹号，as any 不重复计数', () => {
    const root = project({ 'shared/risk.ts': `
      // any, as any, as unknown as, value!
      const message = 'any as any as unknown as value!'
      const value: any = undefined
      const list: Array<any> = []
      const cast = value as any
      const bridge = (value as unknown) as string
      const direct = value as unknown as number
      const asserted = list[0]!.field!
      const logical = !value || value != null
      class Model { definite!: string }
    ` })
    expect(analyzeProject(root).counts).toMatchObject({ explicitAny: 3, doubleAssertions: 2, nonNullAssertions: 2 })
  })

  it('覆盖 TSX、Vue 两种 script 块及模板表达式，模板文字和普通属性不计数', () => {
    const root = project({
      'app/render.tsx': 'const x = <div>{(value as any)!}</div>',
      'app/Page.vue': `<script lang="ts">
        export const normal: any = null
      </script>
      <script setup lang="ts">
        const setup = value as unknown as string
      </script>
      <template>
        <div title="any as unknown as value!">
          any as unknown as value!
          {{ (value as any)! }}
          <button @click="value = $event as any; other!">ok</button>
          <span :title="(value as unknown) as string" />
        </div>
      </template>`,
    })
    const result = analyzeProject(root)
    expect(result.counts).toMatchObject({ explicitAny: 4, doubleAssertions: 2, nonNullAssertions: 3 })
    expect(result.findings.explicitAny).toContain('app/Page.vue:11')
  })

  it('字典忽略属性顺序与引号，按重复组计数；拒绝计算键/spread/方法/非字符串/小字典', () => {
    const root = project({
      'shared/state.ts': `export const state = { READY: 'ready', DONE: 'done', STOP: 'stop' }`,
      'app/Page.vue': `<script setup lang="ts">
        const state = { 'STOP': 'stop', 'DONE': 'done', 'READY': 'ready' }
        const computed = { ['READY']: 'ready', DONE: 'done', STOP: 'stop' }
        const spread = { ...state, DONE: 'done', STOP: 'stop' }
        const method = { READY() {}, DONE: 'done', STOP: 'stop' }
        const numeric = { READY: 0, DONE: 'done', STOP: 'stop' }
        const small = { READY: 'ready', DONE: 'done' }
        const lower = { ready: 'ready', DONE: 'done', STOP: 'stop' }
      </script>
      <template><div :title="({DONE: 'done', STOP: 'stop', READY: 'ready'})" /></template>`,
    })
    const result = analyzeProject(root)
    expect(result.counts).toMatchObject({ duplicateStatusDictionaryGroups: 1 })
    expect(result.duplicateDictionaries[0]?.locations).toHaveLength(3)
  })

  it('循环按强连通组计数，解析 .js 到 .ts / index，覆盖再导出、动态导入与自环', () => {
    const root = project({
      'server/a.ts': `import { b } from './nested/index.js'; export const a = b`,
      'server/nested/index.ts': `export { c as b } from '../../shared/c.js'`,
      'shared/c.ts': `import { a } from '../server/a'; export const c = a`,
      'server/self.ts': `import './self'; export const self = true`,
      'shared/dynamic-a.ts': 'export const load = () => import(`./dynamic-b`)',
      'shared/dynamic-b.ts': `const back = require('./dynamic-a')`,
      'app/x.ts': `import './y'`,
      'app/y.ts': `import './x'`,
    })
    const result = analyzeProject(root)
    expect(result.counts).toMatchObject({ runtimeCycleGroups: 3 })
    expect(result.runtimeCycles).toEqual([
      ['server/a.ts', 'server/nested/index.ts', 'shared/c.ts'],
      ['server/self.ts'],
      ['shared/dynamic-a.ts', 'shared/dynamic-b.ts'],
    ])
  })

  it('import/export type、全 inline type、import 类型查询不构成运行时边', () => {
    const root = project({
      'server/a.ts': `
        import type { B } from './b'
        import { type B as Inline } from './b'
        export type { B } from './b'
        export { type B as Again } from './b'
        type Query = typeof import('./b')
        export const a = true
      `,
      'server/b.ts': `import { a } from './a'; export type B = typeof a`,
    })
    expect(analyzeProject(root).runtimeCycles).toEqual([])
  })

  it('包含 CSS，严格超过 800 行才超限；忽略末尾换行及测试/依赖/生成目录', () => {
    const root = project({
      'app/limit.css': 'a{}\n'.repeat(800),
      'app/over.css': Array(801).fill('a{}').join('\r\n'),
      'shared/over.ts': '\n'.repeat(801),
      'app/tests/fixture.ts': 'const x: any = 1\n'.repeat(900),
      'server/__tests__/fixture.ts': 'const x: any = 1',
      'server/nested/ignored.test.ts': 'const x: any = 1',
      'server/nested/ignored.spec.ts': 'const x: any = 1',
      'shared/types.d.ts': 'declare const x: any',
      'app/node_modules/ignored.ts': 'const x: any = 1',
      'app/.nuxt/ignored.ts': 'const x: any = 1',
    })
    const result = analyzeProject(root)
    expect(result.counts).toMatchObject({ explicitAny: 0, oversizedFiles: 2 })
    expect(result.oversizedFiles).toEqual([{ file: 'app/over.css', lines: 801 }, { file: 'shared/over.ts', lines: 801 }])
  })

  it('无法解析的相对运行时导入必须报错，不能漏边后静默通过', () => {
    const root = project({ 'server/missing.ts': `import './missing-target'` })
    expect(() => analyzeProject(root)).toThrow(/无法解析相对运行时导入/)
  })
})

describe('质量门禁的基线比较', () => {
  it('所有指标上涨均拒绝，回到原值或计数下降允许通过', () => {
    const root = project()
    const baseline = analyzeProject(root)
    writeFiles(root, {
      'app/risk.ts': 'const x: any = value as unknown as string; const y = x!',
      'shared/a.ts': `export const x = { A: 'a', B: 'b', C: 'c' }; import './b'`,
      'shared/b.ts': `export const x = { C: 'c', A: 'a', B: 'b' }; import './a'`,
      'app/long.css': 'a{}\n'.repeat(801),
    })
    const increased = analyzeProject(root)
    const errors = compareBaseline(increased, baseline)
    expect(errors).toEqual(expect.arrayContaining([
      '显式 any（含 as any）: 1 > 0', 'as unknown as: 1 > 0', '非空断言: 1 > 0',
      '重复状态字典组: 1 > 0', '运行时循环依赖组: 1 > 0', '超过 800 行的文件: 1 > 0',
      '新增循环依赖组: shared/a.ts, shared/b.ts', '新增超限文件: app/long.css (801 行)',
    ]))
    expect(compareBaseline(increased, increased)).toEqual([])
    expect(compareBaseline(baseline, increased)).toEqual([])
  })

  it('循环组和超长文件等量替换也拒绝，并给出新增路径', () => {
    const root = project({ 'shared/old.ts': `import './old'`, 'app/old.css': '\n'.repeat(801) })
    const baseline = analyzeProject(root)
    rmSync(join(root, 'shared/old.ts'))
    rmSync(join(root, 'app/old.css'))
    writeFiles(root, { 'shared/new.ts': `import './new'`, 'app/new.css': '\n'.repeat(801) })
    const current = analyzeProject(root)
    expect(current.counts).toEqual(baseline.counts)
    expect(compareBaseline(current, baseline)).toEqual([
      '新增循环依赖组: shared/new.ts', '新增超限文件: app/new.css (801 行)',
    ])
  })

  it('基线缺指标或计数/清单不一致时拒绝，避免比较失效', () => {
    const baseline = analyzeProject(project())
    expect(() => compareBaseline(baseline, { ...baseline, counts: {} })).toThrow(/格式或统计口径版本无效/)
    expect(() => compareBaseline(baseline, { ...baseline, runtimeCycles: [['shared/cycle.ts']] })).toThrow(/格式或统计口径版本无效/)
  })
})
