// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { mount } from '@vue/test-utils'
import * as Vue from 'vue'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadComponent } from '../helpers/vue-component'
import { DRAWING_STATUS_COLOR } from '../../app/composables/useDrawings'
import { ISSUE_STATUS_COLOR } from '../../app/composables/useIssues'
import { PURCHASE_PROGRESS_COLOR } from '../../app/composables/usePurchases'
import { RELEASE_TYPE_COLOR } from '../../app/composables/useReleases'

const NuxtLinkStub = defineComponent({
  props: { to: { type: [String, Object], required: false } },
  setup(props, { slots, attrs }) {
    return () => h('a', { ...attrs, href: typeof props.to === 'string' ? props.to : '#' }, slots.default?.())
  },
})

beforeEach(() => {
  for (const key of ['ref', 'computed', 'reactive', 'watch'] as const) vi.stubGlobal(key, Vue[key])
})

afterEach(() => vi.unstubAllGlobals())

describe('P0 图表几何精度', () => {
  it('UiColumnChart 刻度位置与柱高按同一比例计算，零值不画 6% 假柱，并列最大只高亮首根', () => {
    const ColumnChart = loadComponent('app/components/ui/ColumnChart.vue', { '#components': { NuxtLink: NuxtLinkStub } })
    const w5 = mount(ColumnChart, {
      props: {
        items: [
          { key: 'a', label: '设计', value: 5 },
          { key: 'b', label: '采购', value: 3 },
          { key: 'c', label: '外协', value: 0 },
        ],
      },
    })
    const lines = w5.findAll('.line')
    const tickMap = Object.fromEntries(lines.map((l) => [l.text(), (l.element as HTMLElement).style.bottom]))
    expect(tickMap['5']).toBe('100%')
    expect(tickMap['3']).toBe('60%')
    expect(tickMap['2']).toBe('40%')
    expect(tickMap['0']).toBe('0%')

    const bars = w5.findAll('.bar')
    expect((bars[0]!.element as HTMLElement).style.height).toBe('100%')
    expect((bars[1]!.element as HTMLElement).style.height).toBe('60%')
    expect((bars[2]!.element as HTMLElement).style.height).toBe('2px')
    expect(bars[2]!.classes()).toContain('zero')
    w5.unmount()

    const wTie = mount(ColumnChart, {
      props: {
        items: [
          { key: 'a', label: '设计', value: 2 },
          { key: 'b', label: '采购', value: 2 },
          { key: 'c', label: '生产', value: 1 },
        ],
      },
    })
    expect(wTie.findAll('.bar.top')).toHaveLength(1)
    wTie.unmount()

    const wZero = mount(ColumnChart, {
      props: { items: [{ key: 'a', label: '设计', value: 0 }, { key: 'b', label: '采购', value: 0 }] },
    })
    expect(wZero.findAll('.bar.top')).toHaveLength(0)
    expect(wZero.findAll('.bar.zero')).toHaveLength(2)
    wZero.unmount()
  })

  it('UiBarList 零值不保留最小色块宽度，正数正常按最大值归一', () => {
    const BarList = loadComponent('app/components/ui/BarList.vue')
    const w = mount(BarList, {
      props: {
        items: [
          { key: 'red', label: '红色预警', value: 0 },
          { key: 'yellow', label: '黄色预警', value: 4 },
        ],
      },
    })
    const fills = w.findAll('.fill')
    expect((fills[0]!.element as HTMLElement).style.width).toBe('0%')
    expect(fills[0]!.classes()).not.toContain('nonzero')
    expect((fills[1]!.element as HTMLElement).style.width).toBe('100%')
    expect(fills[1]!.classes()).toContain('nonzero')
    w.unmount()
  })

  it('UiDonut 跳过零值圆弧并使用 pathLength=100 精确归一', () => {
    const Donut = loadComponent('app/components/ui/Donut.vue', { '#components': { NuxtLink: NuxtLinkStub } })
    const w = mount(Donut, {
      props: {
        segments: [
          { key: 'late', label: '预计拖期', value: 3, tone: 'late' },
          { key: 'zero', label: '有风险', value: 0, tone: 'risk' },
          { key: 'ok', label: '正常', value: 1, tone: 'done' },
        ],
      },
    })
    const segs = w.findAll('circle.seg')
    expect(segs).toHaveLength(2)
    expect(segs[0]!.attributes('pathLength')).toBe('100')
    expect(segs[0]!.attributes('stroke-dasharray')).toBe('75 25')
    w.unmount()
  })
})

describe('P0 状态标签语义拆分', () => {
  const bucketOf = (antColor: string) => {
    if (['red', 'error', 'magenta'].includes(antColor)) return 'late'
    if (antColor === 'volcano') return 'upstream'
    if (antColor === 'purple') return 'indigo'
    if (['orange', 'warning', 'gold', 'yellow'].includes(antColor)) return 'risk'
    if (['green', 'success', 'lime'].includes(antColor)) return 'done'
    if (['blue', 'processing', 'geekblue', 'cyan'].includes(antColor)) return 'primary'
    return 'none'
  }

  it('base.css 将 volcano 映射为 upstream 橙、purple 映射为清透靛紫而非混入主色蓝', () => {
    const css = readFileSync('app/assets/base.css', 'utf8')
    expect(css).toContain(':root .ant-tag:is(.ant-tag-volcano) { --tag-dot: var(--ft-upstream); background: var(--ft-upstream-bg); color: var(--ft-upstream-text); }')
    expect(css).toContain(':root .ant-tag:is(.ant-tag-purple) { --tag-dot: var(--ft-indigo); background: var(--ft-indigo-bg); color: var(--ft-indigo-text); }')
  })

  it('设计任务 5 个状态映射到 5 种互不重叠的语义色调', () => {
    const tones = Object.values(DRAWING_STATUS_COLOR).map(bucketOf)
    expect(new Set(tones).size).toBe(5)
  })

  it('异常 4 个状态与发放 3 种类型各自映射到互不重叠的语义色调', () => {
    expect(new Set(Object.values(ISSUE_STATUS_COLOR).map(bucketOf)).size).toBe(4)
    expect(new Set(Object.values(RELEASE_TYPE_COLOR).map(bucketOf)).size).toBe(3)
    expect(bucketOf(PURCHASE_PROGRESS_COLOR.超承诺日!)).toBe('late')
  })
})
