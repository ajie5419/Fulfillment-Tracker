import { vi } from 'vitest'

/** Record actual service reads/writes, including transaction boundaries and SQL locks. */
export const serviceCalls: unknown[][] = []
const methods = new Map<string, ReturnType<typeof vi.fn>>()
const models = new Map<string, object>()

export const serviceDb = new Proxy({}, {
  get(_target, model: string) {
    if (model === '$transaction') return async (run: (db: object) => Promise<unknown>, options?: unknown) => {
      serviceCalls.push(options === undefined ? ['transaction.begin'] : ['transaction.begin', options])
      try {
        const result = await run(serviceDb)
        serviceCalls.push(['transaction.commit'])
        return result
      } catch (error) {
        serviceCalls.push(['transaction.rollback'])
        throw error
      }
    }
    if (model.startsWith('$')) return method(model)
    if (!models.has(model)) models.set(model, new Proxy({}, {
      get(_object, action: string) { return method(`${model}.${action}`) },
    }))
    return models.get(model)
  },
})

export function method(name: string) {
  if (!methods.has(name)) methods.set(name, vi.fn((...args: unknown[]) => {
    throw new Error(`Unconfigured service call: ${name} ${JSON.stringify(args)}`)
  }))
  return methods.get(name)!
}

export function returns(name: string, result: unknown) {
  method(name).mockImplementation((...args: unknown[]) => {
    serviceCalls.push([name, ...args])
    return Promise.resolve(result)
  })
}

export function resetServiceDb() {
  for (const mock of methods.values()) mock.mockReset()
  methods.clear()
  models.clear()
  serviceCalls.length = 0
}
