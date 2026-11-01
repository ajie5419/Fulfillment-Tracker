#!/usr/bin/env node
/**
 * 只扫描 app/、server/、shared/ 的生产源码，跳过 tests、依赖、生成目录和测试文件。
 * TS/JS 与 Vue 两个 script 块用 TypeScript AST；Vue 模板表达式用 Vue 自带的
 * 表达式 AST（vue/compiler-sfc）。注释、字符串内容、普通模板文字和 CSS 不计类型风险。
 * any：每个 AnyKeyword（包括 as any）计一次，不将 as any 重复计数。
 * 双重断言：外层 as 的表达式（去括号）为 as unknown，每处计一次。
 * 非空断言：只计 postfix NonNullExpression；不计逻辑 !、!= 和声明的 definite assignment !。
 * 状态字典：对象字面量至少 3 个属性，均为大写状态码键和字符串值；无 spread、
 * computed、方法或重复键。排序后的键值完全相同才归组，出现至少两份的组计一次。
 * 循环：只建 server+shared 的相对运行时依赖图，包含 import、re-export、字面量
 * import()/require()；排除 import/export type、仅含 inline type 的声明及类型查询。
 * 按强连通分量（含自环）计组，组内文件排序后作为身份，拦截等量替换的新循环组。
 * 行数：所有源码（含 Vue 模板/样式、独立 CSS）的物理行数，末尾换行不多算空行。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parse } from 'vue/compiler-sfc'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASELINE = 'scripts/quality-baseline.json'
const VERSION = 1
const LINE_LIMIT = 800
const ROOTS = ['app', 'server', 'shared']
const CODE = /\.(?:[cm]?[jt]sx?|vue)$/
const SOURCE = /\.(?:[cm]?[jt]sx?|vue|css|scss|sass|less|styl|json)$/
const SKIP_DIRS = new Set(['tests', '__tests__', 'node_modules', '.nuxt', '.output', 'dist', 'coverage'])
const LABELS = {
  explicitAny: '显式 any（含 as any）',
  doubleAssertions: 'as unknown as',
  nonNullAssertions: '非空断言',
  duplicateStatusDictionaryGroups: '重复状态字典组',
  runtimeCycleGroups: '运行时循环依赖组',
  oversizedFiles: '超过 800 行的文件',
}
const posix = (file) => file.split('\\').join('/')
const lineCount = (text) => text ? text.split(/\r\n|\r|\n/).length - (/\r?\n$|\r$/.test(text) ? 1 : 0) : 0
const unwrap = (node) => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node

function walk(root, dir) {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(root, file)
    // 不沿软链离开统计范围，也不把测试夹具/声明文件作为生产实现。
    return entry.isFile() && SOURCE.test(entry.name) && !/\.(?:test|spec|d)\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : []
  }).sort()
}

function dictionaryKey(entries) {
  if (entries.length < 3 || entries.some((entry) => !entry)) return null
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return null
  return JSON.stringify(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}

function tsDictionary(node) {
  return dictionaryKey(node.properties.map((prop) => {
    if (!ts.isPropertyAssignment(prop) || !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) return null
    if (!/^[A-Z][A-Z0-9_]*$/.test(prop.name.text) || !ts.isStringLiteralLike(prop.initializer)) return null
    return [prop.name.text, prop.initializer.text]
  }))
}

function templateDictionary(node) {
  return dictionaryKey(node.properties.map((prop) => {
    if (prop.type !== 'ObjectProperty' || prop.computed || prop.shorthand) return null
    const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.type === 'StringLiteral' ? prop.key.value : null
    if (!key || !/^[A-Z][A-Z0-9_]*$/.test(key)) return null
    const value = prop.value.type === 'StringLiteral' ? prop.value.value
      : prop.value.type === 'TemplateLiteral' && prop.value.expressions.length === 0 ? prop.value.quasis[0].value.cooked : null
    return typeof value === 'string' ? [key, value] : null
  }))
}

function runtimeSpecifier(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause
    if (clause?.isTypeOnly) return null
    const bindings = clause?.namedBindings
    if (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length && bindings.elements.every((x) => x.isTypeOnly)) return null
    return node.moduleSpecifier
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return null
    if (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length && node.exportClause.elements.every((x) => x.isTypeOnly)) return null
    return node.moduleSpecifier
  }
  if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) return node.moduleReference.expression
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) return node.arguments[0]
  return null
}

function cycleGroups(graph) {
  let next = 0
  const indices = new Map()
  const low = new Map()
  const stack = []
  const active = new Set()
  const groups = []
  function visit(file) {
    indices.set(file, next)
    low.set(file, next++)
    stack.push(file)
    active.add(file)
    for (const target of graph.get(file)) {
      if (!indices.has(target)) {
        visit(target)
        low.set(file, Math.min(low.get(file), low.get(target)))
      } else if (active.has(target)) low.set(file, Math.min(low.get(file), indices.get(target)))
    }
    if (indices.get(file) !== low.get(file)) return
    const group = []
    let member
    do {
      member = stack.pop()
      active.delete(member)
      group.push(member)
    } while (member !== file)
    if (group.length > 1 || graph.get(file).has(file)) groups.push(group.sort())
  }
  for (const file of graph.keys()) if (!indices.has(file)) visit(file)
  return groups.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

/** 只读分析；root 参数供单元测试使用隔离夹具，不依赖 git 或 .nuxt。 */
export function analyzeProject(root = ROOT) {
  const files = ROOTS.flatMap((dir) => walk(root, dir))
  const graph = new Map(files.filter((file) => /^(server|shared)\//.test(file) && CODE.test(file)).map((file) => [file, new Set()]))
  const findings = { explicitAny: [], doubleAssertions: [], nonNullAssertions: [] }
  const dictionaries = new Map()
  const oversizedFiles = []
  const resolutionCache = ts.createModuleResolutionCache(root, (file) => file)
  const compilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, resolveJsonModule: true }

  function recordDictionary(key, location) {
    if (!key) return
    const locations = dictionaries.get(key) ?? []
    locations.push(location)
    dictionaries.set(key, locations)
  }
  function addDependency(file, specifier) {
    if (!graph.has(file) || !specifier || !ts.isStringLiteralLike(specifier) || !/^\.{1,2}\//.test(specifier.text)) return
    const result = ts.resolveModuleName(specifier.text, resolve(root, file), compilerOptions, ts.sys, resolutionCache).resolvedModule
    if (!result) throw new Error(`${file}: 无法解析相对运行时导入 ${specifier.text}`)
    const target = posix(relative(root, result.resolvedFileName))
    if (graph.has(target)) graph.get(file).add(target)
  }
  function scanScript(file, content, offset = 0, kind) {
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind)
    if (source.parseDiagnostics.length) {
      const error = source.parseDiagnostics[0]
      throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`)
    }
    function visit(node) {
      const location = () => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + offset + 1}`
      if (node.kind === ts.SyntaxKind.AnyKeyword) findings.explicitAny.push(location())
      if (ts.isNonNullExpression(node)) findings.nonNullAssertions.push(location())
      if (ts.isAsExpression(node)) {
        const inner = unwrap(node.expression)
        if (ts.isAsExpression(inner) && inner.type.kind === ts.SyntaxKind.UnknownKeyword) findings.doubleAssertions.push(location())
      }
      if (ts.isObjectLiteralExpression(node)) recordDictionary(tsDictionary(node), location())
      addDependency(file, runtimeSpecifier(node))
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  function scanTemplate(file, template) {
    // Vue 的表达式 AST 同时支持 v-for/v-slot、事件语句和 TS 语法；不将 HTML 当 TS 解析。
    const seen = new WeakSet()
    function visit(node, expressionLine = 1) {
      if (!node || typeof node !== 'object' || seen.has(node)) return
      seen.add(node)
      if (node.type === 4) expressionLine = node.loc.start.line
      const location = () => `${file}:${expressionLine + (typeof node.type === 'string' ? (node.loc?.start.line ?? 1) - 1 : 0)}`
      if (node.type === 'TSAnyKeyword') findings.explicitAny.push(location())
      if (node.type === 'TSNonNullExpression') findings.nonNullAssertions.push(location())
      if (node.type === 'TSAsExpression' && node.expression.type === 'TSAsExpression' && node.expression.typeAnnotation.type === 'TSUnknownKeyword') findings.doubleAssertions.push(location())
      if (node.type === 'ObjectExpression') recordDictionary(templateDictionary(node), location())
      for (const [key, value] of Object.entries(node)) {
        if (['loc', 'comments', 'errors'].includes(key)) continue
        if (Array.isArray(value)) value.forEach((child) => visit(child, expressionLine))
        else visit(value, expressionLine)
      }
    }
    visit(template.ast)
  }

  for (const file of files) {
    const content = readFileSync(resolve(root, file), 'utf8')
    const lines = lineCount(content)
    if (lines > LINE_LIMIT) oversizedFiles.push({ file, lines })
    if (!CODE.test(file)) continue
    if (extname(file) !== '.vue') {
      scanScript(file, content)
      continue
    }
    const { descriptor, errors } = parse(content, { filename: file })
    if (errors.length) throw new Error(`${file}: ${errors.map((error) => typeof error === 'string' ? error : error.message).join('; ')}`)
    for (const block of [descriptor.script, descriptor.scriptSetup].filter(Boolean)) {
      scanScript(file, block.content, block.loc.start.line - 1, /[jt]sx/.test(block.lang ?? '') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    }
    if (descriptor.template) scanTemplate(file, descriptor.template)
  }
  const duplicateDictionaries = [...dictionaries].filter(([, locations]) => locations.length > 1).map(([key, locations]) => ({ entries: JSON.parse(key), locations }))
  const runtimeCycles = cycleGroups(graph)
  const counts = {
    ...Object.fromEntries(Object.entries(findings).map(([key, locations]) => [key, locations.length])),
    duplicateStatusDictionaryGroups: duplicateDictionaries.length,
    runtimeCycleGroups: runtimeCycles.length,
    oversizedFiles: oversizedFiles.length,
  }
  return { version: VERSION, lineLimit: LINE_LIMIT, counts, runtimeCycles, oversizedFiles, findings, duplicateDictionaries }
}

function validateBaseline(baseline) {
  if (baseline?.version !== VERSION || baseline.lineLimit !== LINE_LIMIT || !baseline.counts
    || Object.keys(LABELS).some((key) => !Number.isSafeInteger(baseline.counts[key]) || baseline.counts[key] < 0)
    || !Array.isArray(baseline.runtimeCycles) || !Array.isArray(baseline.oversizedFiles)
    || baseline.runtimeCycles.some((group) => !Array.isArray(group) || !group.length || group.some((file) => typeof file !== 'string'))
    || baseline.oversizedFiles.some((item) => typeof item.file !== 'string' || !Number.isSafeInteger(item.lines) || item.lines <= LINE_LIMIT)
    || baseline.counts.runtimeCycleGroups !== baseline.runtimeCycles.length || baseline.counts.oversizedFiles !== baseline.oversizedFiles.length) {
    throw new Error(`${BASELINE} 格式或统计口径版本无效，请检查基线文件`)
  }
}

export function compareBaseline(current, baseline) {
  validateBaseline(baseline)
  const violations = []
  for (const [key, label] of Object.entries(LABELS)) {
    if (current.counts[key] <= baseline.counts[key]) continue
    violations.push(`${label}: ${current.counts[key]} > ${baseline.counts[key]}`)
    if (current.findings[key]) violations.push(...current.findings[key].map((location) => `  ${location}`))
    if (key === 'duplicateStatusDictionaryGroups') {
      for (const group of current.duplicateDictionaries) violations.push(`  ${JSON.stringify(group.entries)}: ${group.locations.join(', ')}`)
    }
  }
  const knownCycles = new Set(baseline.runtimeCycles.map((group) => JSON.stringify([...group].sort())))
  for (const group of current.runtimeCycles) if (!knownCycles.has(JSON.stringify([...group].sort()))) violations.push(`新增循环依赖组: ${group.join(', ')}`)
  const knownFiles = new Set(baseline.oversizedFiles.map((item) => item.file))
  for (const item of current.oversizedFiles) if (!knownFiles.has(item.file)) violations.push(`新增超限文件: ${item.file} (${item.lines} 行)`)
  return violations
}

function main() {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--write-baseline')) throw new Error('用法: node scripts/quality-gate.mjs [--write-baseline]')
  const current = analyzeProject()
  const path = resolve(ROOT, BASELINE)
  if (args.includes('--write-baseline')) {
    const { findings, duplicateDictionaries, ...baseline } = current
    writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`)
    console.log(`已写入 ${BASELINE}（整改后计数下降时随 PR 提交）`)
  }
  let baseline
  try {
    baseline = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`缺少 ${BASELINE}，请先运行 node scripts/quality-gate.mjs --write-baseline`)
    throw error
  }
  const violations = compareBaseline(current, baseline)
  console.log('| 指标 | 基线 | 当前 | 结果 |')
  console.log('| --- | ---: | ---: | --- |')
  for (const [key, label] of Object.entries(LABELS)) console.log(`| ${label} | ${baseline.counts[key]} | ${current.counts[key]} | ${current.counts[key] <= baseline.counts[key] ? 'PASS' : 'FAIL'} |`)
  console.log(`\n超过 ${LINE_LIMIT} 行的生产文件：`)
  for (const item of current.oversizedFiles) console.log(`  ${item.file}: ${item.lines}`)
  if (violations.length) {
    console.error(`\n质量门禁失败：\n${violations.join('\n')}`)
    process.exitCode = 1
  } else console.log('\n质量门禁通过')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    console.error(`质量门禁失败: ${error.message}`)
    process.exitCode = 1
  }
}
