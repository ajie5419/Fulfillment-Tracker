/** Small predicate evaluator for pagination contract tests; unknown operators fail loudly. */
export function matchesRow(row: object, where: object): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      const clauses: object[] = Array.isArray(condition) ? condition : [condition]
      if (key === 'OR') return clauses.some((c) => matchesRow(row, c))
      return clauses.every((c) => key === 'NOT' ? !matchesRow(row, c) : matchesRow(row, c))
    }
    const value = Reflect.get(row, key)
    if (condition instanceof Date) return +value === +condition
    if (condition === null || typeof condition !== 'object') return value === condition
    return Object.entries(condition).every(([op, expected]) => {
      if (op === 'in' && Array.isArray(expected)) return expected.includes(value)
      if (op === 'notIn' && Array.isArray(expected)) return value != null && !expected.includes(value)
      if (op === 'not') return expected === null ? value != null : value !== expected
      if (op === 'equals') return value === expected
      if (value == null) return false
      const a = value instanceof Date ? +value : value
      const b = expected instanceof Date ? +expected : expected
      if ((typeof a === 'number' || typeof a === 'string') && (typeof b === 'number' || typeof b === 'string')) {
        if (op === 'lt') return a < b
        if (op === 'lte') return a <= b
        if (op === 'gt') return a > b
        if (op === 'gte') return a >= b
      }
      throw new Error(`Unsupported predicate: ${key}.${op}`)
    })
  })
}

export function queryRows<T extends object>(rows: T[], query: { where?: object; orderBy?: object | object[]; skip?: number; take?: number }): T[] {
  const orders = Array.isArray(query.orderBy) ? query.orderBy : query.orderBy ? [query.orderBy] : []
  const sorted = rows.filter((r) => matchesRow(r, query.where ?? {})).sort((a, b) => {
    for (const order of orders) {
      const [key, direction] = Object.entries(order)[0]!
      const av = Reflect.get(a, key), bv = Reflect.get(b, key)
      const cmp = av < bv ? -1 : av > bv ? 1 : 0
      if (cmp) return direction === 'desc' ? -cmp : cmp
    }
    return 0
  })
  return sorted.slice(query.skip ?? 0, query.take === undefined ? undefined : (query.skip ?? 0) + query.take)
}
