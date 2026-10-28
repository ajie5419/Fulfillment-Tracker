import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import * as Vue from 'vue'

const require = createRequire(import.meta.url)
type HostNode = { children: HostNode[]; parent: HostNode | null }
const node = (): HostNode => ({ children: [], parent: null })
const renderer = Vue.createRenderer<HostNode, HostNode>({
  createElement: node, createText: node, createComment: node,
  setText() {}, setElementText() {}, patchProp() {},
  parentNode: (n) => n.parent,
  nextSibling: (n) => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
  insert(child, parent, anchor) {
    child.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(child)
    else parent.children.splice(index, 0, child)
  },
  remove(n) {
    if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1)
    n.parent = null
  },
})

export async function flushVue() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}

/** Compile the real SFC script; keep Vue watchers and lifecycle, stub only its view and I/O. */
export async function mountScript(file: string, initialProps: Record<string, unknown> = {}, modules: Record<string, unknown> = {}) {
  const path = resolve(file)
  const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path })
  const script = compileScript(descriptor, { id: file })
  const code = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const mod = { exports: {} as { default?: Vue.ComponentOptions } }
  new Function('require', 'module', 'exports', code)((id: string) => modules[id] ?? require(id), mod, mod.exports)
  const component = mod.exports.default!
  const setup = component.setup!
  let state: Record<string, any>
  component.setup = function (props, context) {
    const result = setup(props, context)
    const capture = (value: any) => { state = Vue.proxyRefs(value); return value }
    return result instanceof Promise ? result.then(capture) : capture(result)
  }
  component.render = () => null
  const props = Vue.reactive(initialProps)
  const events: unknown[][] = []
  const app = renderer.createApp({
    setup: () => () => Vue.h(Vue.Suspense, null, {
      default: () => Vue.h(component, { ...props, onDone: (...args: unknown[]) => events.push(args), onChanged: () => events.push(['changed']) }),
    }),
  })
  app.mount(node())
  await flushVue()
  return { state: state!, props, events, unmount: () => app.unmount() }
}

export function deferred<T = any>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
