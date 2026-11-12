import ts from 'typescript'
import { parse } from 'vue/compiler-sfc'

const RESPONSE_MODELS = new Set(['DrawingRow', 'DrawingStats', 'DrawingResult'])
const ROUTING_FILES = new Set(['shared/process.ts', 'server/services/process/eligibility.ts'])
const QUANTITY_FILES = new Set(['server/schemas/purchases.ts', 'server/services/purchases/import.ts', 'app/components/PurchaseEditModal.vue'])
const UPLOAD_FILES = new Set([
  'app/components/ReleaseCreateModal.vue', 'app/components/ReleaseBomField.vue',
  'app/components/IssueReportModal.vue', 'app/pages/m/issue-new.vue',
  'server/services/issues/uploads.ts', 'server/api/uploads.post.ts', 'server/api/bom/excel.post.ts',
])
const isServerPath = value => /(?:^|\/|#)server(?:\/|$)/.test(value)

/** Enforce known architectural boundaries, not arbitrary semantic similarity. No baseline exemptions. */
export function inspectArchitecture(file, content) {
  const violations = []
  const add = (line, rule) => violations.push(`${file}:${line}: ${rule}`)
  const script = (text, offset = 0) => {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const line = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + offset + 1
    function visit(node) {
      if (file.startsWith('server/api/') && ts.isExportAssignment(node)) {
        const expression = node.expression
        const handler = ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) ? expression.expression.text : ''
        const files = ['server/api/files/[id].get.ts', 'server/api/purchases/template.get.ts']
        const allowed = files.includes(file) ? ['defineFileHandler'] : ['defineApiHandler', 'defineFlowHandler', 'defineAdminHandler']
        if (!allowed.includes(handler)) add(line(node), 'api-response-contract: API 必须通过统一响应入口，下载入口单独列明')
      }
      if (file.startsWith('app/') && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text
        const boundary = ['app/utils/api-fetch.ts', 'app/composables/useApiFetch.ts', 'app/plugins/api-401.client.ts'].includes(file)
        const logout = name === '$fetch' && ts.isStringLiteralLike(node.arguments[0] ?? node) && node.arguments[0].text === '/auth/logout'
        if (!boundary && !logout && ['$fetch', 'useFetch', 'useRequestFetch', 'fetch'].includes(name)) {
          add(line(node), 'api-response-contract: 页面请求必须通过统一解包层')
        }
      }
      if (file.startsWith('app/') && (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))) {
        const clause = ts.isImportDeclaration(node) ? node.importClause : node.exportClause
        const typeOnly = node.isTypeOnly || clause?.isTypeOnly || (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(n => n.isTypeOnly))
          || (clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every(n => n.isTypeOnly))
        if (!typeOnly && node.moduleSpecifier && isServerPath(node.moduleSpecifier.text)) add(line(node), 'client-server-boundary: 前端只能以 type 引用服务端')
      }
      if (file.startsWith('app/') && ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        const specifier = node.moduleReference.expression
        if (specifier && ts.isStringLiteralLike(specifier) && isServerPath(specifier.text)) add(line(node), 'client-server-boundary: 前端只能以 type 引用服务端')
      }
      if (file.startsWith('app/') && ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const specifier = node.arguments[0]
        if (specifier && ts.isStringLiteralLike(specifier) && isServerPath(specifier.text)) add(line(node), 'client-server-boundary: 前端不能动态加载服务端')
      }
      if (file.startsWith('app/') && (ts.isInterfaceDeclaration(node) || (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type))) && RESPONSE_MODELS.has(node.name.text)) {
        add(line(node), 'derived-api-model: 已治理的响应模型必须从 ClientResponse 派生')
      }
      const errorProperty = ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && /^(?:err|error)$/.test(node.expression.text)
      const nameAccess = ts.isPropertyAccessExpression(node) && node.name.text === 'name' && !errorProperty
      const nameIndex = ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'name'
      const nameBinding = ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(source).replace(/['"]/g, '') === 'name'
      if (ROUTING_FILES.has(file) && (nameAccess || nameIndex || nameBinding || (ts.isPropertyAssignment(node) && node.name.getText(source).replace(/['"]/g, '') === 'name'))) {
        add(line(node), 'explicit-process-routing: 工艺分流不能依赖节点显示名称')
      }
      if (file === 'server/services/auth/permissions.ts' && ts.isIdentifier(node) && node.text === 'BUSINESS_DEPT_NAME' && !ts.isImportSpecifier(node.parent)) {
        add(line(node), 'stable-department-identity: 权限判断不能使用部门显示名称')
      }
      if (QUANTITY_FILES.has(file) && ts.isNumericLiteral(node) && Number(node.text) === 1e9) {
        add(line(node), 'shared-purchase-quantity: 数量限制必须引用共享策略')
      }
      if (UPLOAD_FILES.has(file) && (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /\b\d+(?:\.\d+)?\s*(?:MB|MiB)\b/.test(node.text)) {
        add(line(node), 'derived-upload-label: 上传大小提示必须从共享限制生成')
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  if (file.endsWith('.vue')) {
    const { descriptor } = parse(content, { filename: file })
    for (const block of [descriptor.script, descriptor.scriptSetup].filter(Boolean)) script(block.content, block.loc.start.line - 1)
    if (descriptor.template) {
      const template = descriptor.template.content.replace(/<!--[\s\S]*?-->/g, '')
      if (UPLOAD_FILES.has(file) && /\b\d+(?:\.\d+)?\s*(?:MB|MiB)\b/.test(template)) add(descriptor.template.loc.start.line, 'derived-upload-label: 上传大小说明必须引用共享限制')
      if (file === 'app/components/PurchaseEditModal.vue' && /:(?:precision|max|min)\s*=\s*["']\d+(?:\.\d+)?["']/.test(template)) add(descriptor.template.loc.start.line, 'shared-purchase-quantity: 表单数量限制必须引用共享策略')
    }
  } else script(content)
  return [...new Set(violations)]
}
