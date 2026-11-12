import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import { expect, it } from 'vitest'

it.each(['setTimeout(() => { throw new Error("secret-value") }, 0)', 'Promise.reject(new Error("secret-value"))'])('records a real child process fatal error and exits nonzero', trigger => {
  const code = ts.transpileModule(readFileSync('server/observability/fatal.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `${code}\ninstallFatalHandlers();\nprocess.on('uncaughtException', () => console.error('unsafe framework listener'));\nprocess.on('unhandledRejection', () => console.error('unsafe framework listener'));\n${trigger}`], { encoding: 'utf8', timeout: 5000 })
  expect(result.status).toBe(1)
  expect(result.stderr).not.toMatch(/secret-value|unsafe framework/)
  expect(JSON.parse(result.stderr)).toMatchObject({ level: 'fatal', event: 'process.fatal' })
})
