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

  it('upgrades default.vue with 100dvh, concentric 24px frame radius, and narrow-screen overlay drawer + Escape', () => {
    const layout = readFileSync('app/layouts/default.vue', 'utf8')
    expect(layout).toContain('height: 100dvh')
    expect(layout).toContain('border-radius: 24px')
    expect(layout).toContain('class="sider-mask"')
    expect(layout).toContain("e.key === 'Escape'")
  })

  it('keeps WoGroupHead count text at AA contrast (--ft-text-2) on gray --ft-fill background', () => {
    const head = readFileSync('app/components/ui/WoGroupHead.vue', 'utf8')
    expect(head).not.toContain('var(--ft-text-3)')
    expect(head).toContain('color: var(--ft-text-2)')
  })

  it('aligns index.vue and risks.vue with Bento ft-well containers, capsule tags, keyboard access, and single-accent CTA', () => {
    const index = readFileSync('app/pages/index.vue', 'utf8')
    expect(index).toContain('class="ft-well cards"')
    expect(index).toContain('border-radius: 999px')
    expect(index).toContain(':tabindex="c.reminder ? 0 : undefined"')
    expect(index).toContain('@keydown.space.prevent="onCardClick(c)"')
    expect(index).not.toContain('var(--ft-text-3); font-size: 12px')

    const risks = readFileSync('app/pages/risks.vue', 'utf8')
    expect(risks).toContain('class="ft-well list"')
    expect(risks).toContain('<a-button type="primary" @click="reporting = true">上报异常</a-button>')
    expect(risks).not.toContain('danger @click="reporting = true"')
    expect(risks).toContain('@keydown.space.prevent="selected = it.i.id"')
    expect(risks).toContain('border-radius: 999px')
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
