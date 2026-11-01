import { readFileSync } from 'node:fs'
import ts from 'typescript'

/** 执行真实文件中的指定纯声明，钉住私有服务校验与组件 computed 的边界，不加载其 I/O。 */
export function pureDeclarations(file: string, names: string[], dependencies: Record<string, unknown>) {
  const source = readFileSync(file, 'utf8').replace(/^<script setup lang="ts">/, '').split('</script>')[0]!
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declarations = ast.statements.filter((statement) => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)))
  if (declarations.length !== names.length) throw new Error(`Missing pure declaration in ${file}`)
  const code = ts.transpileModule(declarations.map((node) => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  return new Function(...Object.keys(dependencies), `${code}\nreturn { ${names.join(', ')} }`)(...Object.values(dependencies))
}
