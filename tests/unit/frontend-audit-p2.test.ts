// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as mobileTodo from '../../shared/mobile-todo'
import { loadComponent } from '../helpers/vue-component'

afterEach(() => vi.unstubAllGlobals())

describe('Frontend audit P2: accessibility, motion preferences, narrow-screen drawer, and mobile /m ergonomics', () => {
  it('declares global prefers-reduced-motion support in app.vue', () => {
    const app = readFileSync('app/app.vue', 'utf8')
    expect(app).toContain('@media (prefers-reduced-motion: reduce)')
    expect(app).toContain('transition-duration: 0.01ms !important')
  })

  it('upgrades default.vue with 100dvh, Ember inset workspace sheet + bottom profile card, and narrow-screen overlay drawer + Escape', () => {
    const layout = readFileSync('app/layouts/default.vue', 'utf8')
    expect(layout).toContain('height: 100dvh')
    expect(layout).toContain('border-radius: 16px')
    expect(layout).toContain('var(--card-sheet-bg)')
    expect(layout).toContain('class="user-card"')
    expect(layout).toContain('class="sider-mask"')
    expect(layout).toContain("e.key === 'Escape'")
  })

  it('enforces 90-degree top-lit tactile card tokens (1px optical hairline, top inner glow, and multi-layer elevation shadows)', () => {
    const baseCss = readFileSync('app/assets/base.css', 'utf8')
    expect(baseCss).toContain('--card-hairline-top:')
    expect(baseCss).toContain('--card-hairline-bottom:')
    expect(baseCss).toContain('inset 0 1px 0 0 #FFFFFF')
    expect(baseCss).toContain('background-clip: padding-box')

    const statCard = readFileSync('app/components/ui/StatCard.vue', 'utf8')
    expect(statCard).toContain('var(--card-tray-shadow)')
    expect(statCard).toContain('var(--card-panel-shadow)')

    const sectionCard = readFileSync('app/components/ui/SectionCard.vue', 'utf8')
    expect(sectionCard).toContain('var(--card-surface-sheen)')
    expect(sectionCard).toContain('background-clip: padding-box')
  })

  it('keeps WoGroupHead count text at AA contrast (--ft-text-2) on gray --ft-fill background', () => {
    const head = readFileSync('app/components/ui/WoGroupHead.vue', 'utf8')
    expect(head).not.toContain('var(--ft-text-3)')
    expect(head).toContain('color: var(--ft-text-2)')
  })

  it('aligns index.vue and risks.vue with Ember UiPageHero, Payouts-style borderless feed rows, keyboard access, and ink primary CTA', () => {
    const hero = readFileSync('app/components/ui/PageHero.vue', 'utf8')
    expect(hero).toContain('class="ft-hero-title"')
    expect(hero).toContain('class="ft-hero-spark"')

    const index = readFileSync('app/pages/index.vue', 'utf8')
    expect(index).toContain('<UiPageHero :title="heroTitle" :summary="heroSummary">')
    expect(index).toContain('<UiSectionCard icon="inbox" padding="none" title="待办与提醒"')
    expect(index).toContain('class="wrow"')
    expect(index).toContain('class="row-badge"')
    expect(index).toContain(':tabindex="c.reminder ? 0 : undefined"')
    expect(index).toContain('@keydown.space.prevent="onCardClick(c)"')

    const risks = readFileSync('app/pages/risks.vue', 'utf8')
    expect(risks).toContain('<UiPageHero title="风险与异常监控" :summary="heroSummary">')
    expect(risks).toContain('<UiSectionCard icon="shield" padding="none" title="风险明细"')
    expect(risks).toContain('<a-button type="primary" class="ft-btn-ink" @click="reporting = true">上报异常</a-button>')
    expect(risks).not.toContain('danger @click="reporting = true"')
    expect(risks).toContain('@keydown.space.prevent="selected = it.i.id"')
  })

  it('improves mobile /m viewport, fixed tabbar bounds, MCard keyboard access, account switch, and above-the-fold priority', async () => {
    const mobileCss = readFileSync('app/assets/mobile.css', 'utf8')
    expect(mobileCss).toContain('min-height: 100dvh')
    expect(mobileCss).toContain('.ft-m .van-tabbar--fixed { max-width: 640px;')

    const mIndex = readFileSync('app/pages/m/index.vue', 'utf8')
    expect(mIndex).toContain('right-text="切换账号"')
    expect(mIndex).toContain('@click-right="logout"')
    expect(mIndex).toContain('entriesExpanded')
    expect(mIndex).toContain('unreadRedCount')
    expect(mIndex).not.toContain('size="mini"')

    vi.stubGlobal('computed', Vue.computed)
    const MCard = loadComponent('app/components/m/Card.vue', { '#shared/mobile-todo': mobileTodo })
    const wrapper = mount(MCard, {
      props: { tone: 'late', label: '延误', link: true },
      global: { stubs: { UiStatusIcon: true, 'van-icon': true } },
    })
    const root = wrapper.find('.m-card')
    expect(root.attributes('role')).toBe('button')
    expect(root.attributes('tabindex')).toBe('0')
    await root.trigger('keydown.enter')
    expect(wrapper.emitted('click')).toHaveLength(1)
    wrapper.unmount()
  })
})
