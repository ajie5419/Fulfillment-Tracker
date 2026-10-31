import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Frontend audit P1: layout hierarchy, Bento card physics, and table unification', () => {
  it('removes duplicate <h1> page titles from board.vue and plan.vue since default.vue topbar renders them', () => {
    const board = readFileSync('app/pages/board.vue', 'utf8')
    const plan = readFileSync('app/pages/plan.vue', 'utf8')
    expect(board).not.toContain('<h1')
    expect(plan).not.toContain('<h1')
    expect(plan).toContain('<UiHelpTip')
  })

  it('unifies Bento capsule StatCard, BoardWoCard, and flat-capable SectionCard hover physics, contrast, active state, and tabular-nums', () => {
    const statCard = readFileSync('app/components/ui/StatCard.vue', 'utf8')
    expect(statCard).not.toContain('rgba(')
    expect(statCard).toContain('ft-stat-iconbox')
    expect(statCard).toContain('ft-stat-ticks')
    expect(statCard).toContain('font-variant-numeric: tabular-nums')
    expect(statCard).toContain('var(--ft-late-text)')
    expect(statCard).toContain('.ft-stat.active { border-color: var(--ft-primary); background: var(--ft-primary-bg);')
    expect(statCard).toContain('.ft-stat.link:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; }')

    const woCard = readFileSync('app/components/BoardWoCard.vue', 'utf8')
    expect(woCard).not.toContain('rgba(')
    expect(woCard).toContain('a.card:focus-visible')
    expect(woCard).toContain('font-variant-numeric: tabular-nums')

    const sectionCard = readFileSync('app/components/ui/SectionCard.vue', 'utf8')
    expect(sectionCard).not.toContain('ft-section-inner')
    expect(sectionCard).toContain('.ft-section.flat {')
    expect(sectionCard).toContain('.ft-section.flat > .ft-section-panel { padding: 0; }')
    expect(sectionCard).toContain('.sub { margin-top: 2px; font-size: 12px; color: var(--ft-text-2); }')
  })

  it('aligns base.css a-card title size to 16px and prevents double horizontal indent on .ant-card-body .ft-table', () => {
    const css = readFileSync('app/assets/base.css', 'utf8')
    expect(css).toContain('font-size: 16px; font-weight: 600')
    expect(css).not.toContain('font-size: 17px')
    expect(css).toContain('.ant-card-body .ft-table.ant-table-wrapper')
  })

  it.each(['purchases', 'drawings', 'kitting', 'payments', 'releases'])(
    '%s uses ft-table, avoids stat-bar CLS on pending, and uses accessible buttons instead of <a @click>',
    (page) => {
      const source = readFileSync(`app/pages/${page}.vue`, 'utf8')
      expect(source).toContain('class="ft-table"')
      expect(source).not.toMatch(/v-if="stats && !(?:statsPending|pending)/)
      expect(source).not.toMatch(/<a(?=\s|>)[^>]*@click=/)
      expect(source).not.toContain('color: var(--ft-late);')
    },
  )
})
