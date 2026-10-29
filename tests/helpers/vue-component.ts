import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import type { ComponentOptions } from 'vue'

const require = createRequire(import.meta.url)

/** Compile the real script and template without Nuxt; callers stub only auto-imports and I/O. */
export function loadComponent(file: string, modules: Record<string, unknown> = {}) {
  const filename = resolve(file)
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: file })
  const template = compileTemplate({
    id: file, filename, source: descriptor.template!.content,
    compilerOptions: { bindingMetadata: script.bindings },
  })
  if (template.errors.length) throw new Error(template.errors.join('\n'))
  const evaluate = (source: string) => {
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
    const mod = { exports: {} as any }
    new Function('require', 'module', 'exports', code)((id: string) => modules[id] ?? require(id), mod, mod.exports)
    return mod.exports
  }
  const component = evaluate(script.content).default as ComponentOptions
  component.render = evaluate(template.code).render
  return component
}
