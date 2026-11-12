// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import * as Vue from 'vue'
import * as boardCockpitShared from '../../shared/board-cockpit'
import * as monitoringShared from '../../shared/monitoring'
import * as panoramaShared from '../../shared/panorama'
import { loadComponent } from '../helpers/vue-component'

const cleanups: (() => void)[] = []

const container = Vue.defineComponent({
  props: ['title', 'subTitle', 'message', 'description', 'label', 'value', 'sub', 'unit', 'tone'],
  setup: (props, { slots }) => () =>
    Vue.h('div', { class: 'stub-container', 'data-title': props.title, 'data-label': props.label, 'data-value': props.value }, [
      props.title,
      props.subTitle,
      props.message,
      props.description,
      props.label,
      props.value != null ? String(props.value) : '',
      props.sub,
      props.unit,
      slots.title?.(),
      slots.default?.(),
      slots.extra?.(),
      slots.actions?.(),
      slots.titleAfter?.(),
      slots.sub?.(),
    ]),
})

const button = Vue.defineComponent({
  setup: (_, { slots }) => () => Vue.h('button', slots.default?.()),
})

const nuxtLink = Vue.defineComponent({
  props: ['to'],
  setup: (props, { slots, attrs }) => () => Vue.h('a', { href: props.to, ...attrs }, slots.default?.()),
})

const statusTag = Vue.defineComponent({
  props: ['tone'],
  setup: (props, { slots }) => () => Vue.h('span', { class: `ft-status-tag tone-${props.tone}` }, slots.default?.()),
})

beforeEach(() => {
  for (const name of ['ref', 'computed', 'reactive', 'watch', 'onMounted', 'onBeforeUnmount', 'nextTick'] as const) {
    vi.stubGlobal(name, Vue[name])
  }
  vi.stubGlobal('apiError', (e: any) => (e instanceof Error ? e.message : String(e ?? 'error')))
})

afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  vi.unstubAllGlobals()
})

describe('全盘统计双端组件', () => {
  async function render(mobile = false, opts: { error?: boolean; pending?: boolean; empty?: boolean } = {}) {
    const route = Vue.reactive({ query: {} as Record<string, unknown>, fullPath: mobile ? '/m/board?view=orders&manager=pm' : '/board?view=panorama&manager=pm' })
    const replace = vi.fn(async (location: any) => { route.query = location.query })
    const refresh = vi.fn()
    const row = { workOrderNumber: 'WO-01', projectName: '项目', projectManagerId: 'pm', projectManagerName: '张经理', productLine: null, status: 'IN_PROGRESS', color: 'RED', openIssues: 2 }
    vi.stubGlobal('useRoute', () => route)
    vi.stubGlobal('useRouter', () => ({ replace }))
    vi.stubGlobal('useApiFetch', async (url: string, options: any) => {
      expect(url).toBe('/api/board')
      expect(options.query).toEqual({ closed: '1' })
      return { data: Vue.ref(opts.empty ? { rows: [] } : { rows: [row] }), pending: Vue.ref(!!opts.pending), error: Vue.ref(opts.error ? new Error('网络超时') : null), refresh }
    })
    const component = loadComponent('app/components/BoardPanorama.vue', {
      '#shared/panorama': panoramaShared,
      '#shared/status': await import('../../shared/status'),
    })
    const link = Vue.defineComponent({ props: ['to'], setup: (props, { slots }) => () => Vue.h('a', { href: typeof props.to === 'string' ? props.to : props.to.path + '?' + new URLSearchParams(props.to.query).toString() }, slots.default?.()) })
    const wrapper = mount(Vue.defineComponent({ setup: () => () => Vue.h(Vue.Suspense, null, { default: () => Vue.h(component, { mobile }) }) }), {
      global: {
        plugins: [(app: Vue.App) => { Object.assign(app.config.globalProperties, { apiError: (error: Error) => error.message }) }],
        stubs: { UiPageHero: container, UiStatCard: container, UiSectionCard: container, UiListItem: container, UiRefreshButton: button, AResult: container, AButton: button, VanButton: button, VanCell: container, VanEmpty: container, MCard: container, NuxtLink: link },
      },
    })
    cleanups.push(() => wrapper.unmount())
    await flushPromises()
    return { wrapper, route, replace, refresh }
  }

  it.each([false, true])('统计、分组及清单双端一致且保留工单处理上下文 mobile=%s', async mobile => {
    const { wrapper, replace } = await render(mobile)
    expect(wrapper.text()).toContain('有风险在制工单')
    expect(wrapper.text()).toContain('待接入')
    expect(wrapper.text()).toContain('张经理')
    expect(wrapper.text()).toContain('未指定产品线')
    expect(wrapper.text()).toContain('WO-01')
    const riskGroup = wrapper.findAll('button').find(item => item.text() === '有风险 1')
    expect(riskGroup).toBeDefined()
    await riskGroup!.trigger('click')
    await flushPromises()
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ metric: 'abnormal', manager: 'pm', view: mobile ? 'orders' : 'panorama' }) }))
    const processing = wrapper.findAll('a').find(item => item.attributes('href')?.startsWith(mobile ? '/m/issues?' : '/risks?'))!
    const destination = new URL(processing.attributes('href') ?? '', 'https://example.test')
    expect(destination.pathname).toBe(mobile ? '/m/issues' : '/risks')
    expect(destination.searchParams.get(mobile ? 'workOrderNumber' : 'wo')).toBe('WO-01')
    expect(destination.searchParams.get('returnTo')).toContain(mobile ? '/m/board?' : '/board?')
  })

  it.each([false, true])('失败可重试且不误显空数据 mobile=%s', async mobile => {
    const { wrapper, refresh } = await render(mobile, { error: true })
    if (!mobile) expect(wrapper.text()).toContain('全盘统计加载失败')
    expect(wrapper.text()).not.toContain('此条件下没有可见工单')
    expect(wrapper.text()).not.toContain('WO-01')
    await wrapper.findAll('button').find(item => item.text() === '重试')!.trigger('click')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it.each([false, true])('空数据与加载中分别呈现 mobile=%s', async mobile => {
    const empty = await render(mobile, { empty: true })
    expect(empty.wrapper.text()).toContain('此条件下没有可见工单')
    const loading = await render(mobile, { pending: true })
    expect(loading.wrapper.text()).toContain('正在加载可见工单')
    expect(loading.wrapper.text()).not.toContain('此条件下没有可见工单')
    expect(loading.wrapper.text()).toContain('—')
  })
})

describe('驾驶舱红色清单 BoardCockpit.vue 呈现与 also 胶囊', () => {
  it('正确拉取 entities 分页并渲染 also 胶囊与新口径 HelpTip', async () => {
    const mockOverview = {
      summary: { red: 1, overdueIssues: 1, newIssues: 0, closedIssues: 0 },
      stages: [],
      redStages: [],
      redWorkOrders: [
        {
          workOrderNumber: 'WO-100',
          projectName: '机甲项目',
          projectManagerName: '赵经理',
          reason: '延误预警',
          delayDays: 3,
        },
      ],
    }
    const mockMonitoringStatus = {
      asOf: new Date(),
      threshold: {},
      redCount: 2,
      top: [],
    }
    const mockReleasesStats = { pending: 0 }
    const mockIssues = [
      {
        id: 'issue-1',
        issueNo: 'YC-01',
        description: '料单迟滞',
        workOrderNumber: 'WO-100',
        responsibleDeptName: '技术部',
        responsibleUserName: '李工',
        overdue: true,
        overdueDays: 5,
      },
      {
        id: 'issue-2',
        issueNo: 'YC-02',
        description: '待受理超期样本',
        workOrderNumber: 'WO-100',
        responsibleDeptName: '生产部',
        responsibleUserName: null,
        overdue: true,
        overdueDays: 0,
      },
    ]

    const fetchedPages: number[] = []
    vi.stubGlobal('apiFetch', async (url: string, opts: any) => {
      if (url === '/api/monitoring/entities') {
        const page = opts.query.page
        fetchedPages.push(page)
        if (page === 1) {
          return {
            asOf: new Date().toISOString(),
            threshold: {},
            total: 2,
            rows: [
              {
                entityType: 'step',
                id: 'step-1',
                partId: 'part-1',
                name: '法兰 · 铣削',
                drawingNo: null,
                workOrderNumber: 'WO-100',
                status: 'IN_PROGRESS',
                statusText: '加工中',
                since: new Date(),
                sinceSource: 'startedAt',
                days: 12,
                level: 'RED',
                ownerIds: [],
                owners: [],
                deptNames: ['车间'],
                link: '/parts?wo=WO-100&part=part-1&step=step-1',
              },
              {
                entityType: 'part',
                id: 'part-2',
                partId: 'part-2',
                name: '支架',
                drawingNo: 'D-99',
                workOrderNumber: 'WO-200',
                status: 'ACTIVE',
                statusText: '在制',
                since: new Date(),
                sinceSource: 'createdAt',
                days: 20,
                level: 'RED',
                ownerIds: [],
                owners: [],
                deptNames: [],
                link: '/parts?wo=WO-200&part=part-2',
              },
            ],
          }
        }
        return { asOf: new Date().toISOString(), threshold: {}, total: 2, rows: [] }
      }
      throw new Error(`Unexpected url: ${url}`)
    })

    vi.stubGlobal('useApiFetch', async (url: string) => {
      if (url === '/api/overview') return { data: Vue.ref(mockOverview), pending: Vue.ref(false), error: Vue.ref(null), refresh: vi.fn() }
      if (url === '/api/monitoring/status') return { data: Vue.ref(mockMonitoringStatus), pending: Vue.ref(false), error: Vue.ref(null), refresh: vi.fn() }
      if (url === '/api/releases/stats') return { data: Vue.ref(mockReleasesStats), pending: Vue.ref(false), error: Vue.ref(null), refresh: vi.fn() }
      if (url === '/api/issues') return { data: Vue.ref(mockIssues), pending: Vue.ref(false), error: Vue.ref(null), refresh: vi.fn() }
      return { data: Vue.ref(null), pending: Vue.ref(false), error: Vue.ref(null), refresh: vi.fn() }
    })

    vi.stubGlobal('useAsyncData', async (_key: string, fn: () => Promise<any>) => {
      const data = Vue.ref(await fn())
      return { data, pending: Vue.ref(false), error: Vue.ref(null), refresh: vi.fn() }
    })

    vi.stubGlobal('useRequestHeaders', () => ({}))

    const component = loadComponent('app/components/BoardCockpit.vue', {
      '#shared/board-cockpit': boardCockpitShared,
      '#shared/monitoring': monitoringShared,
    })

    const wrapper = mount(
      Vue.defineComponent({
        setup: () => () => Vue.h(Vue.Suspense, null, { default: () => Vue.h(component) }),
      }),
      {
        global: {
          plugins: [
            (app: Vue.App) => {
              Object.assign(app.config.globalProperties, {
                apiError: (e: any) => (e instanceof Error ? e.message : String(e ?? 'error')),
              })
            },
          ],
          stubs: {
            UiStatCard: container,
            UiSectionCard: container,
            UiHelpTip: container,
            UiListItem: Vue.defineComponent({
              props: ['tone', 'compact'],
              setup: (_, { slots }) => () =>
                Vue.h('div', { class: 'ft-li' }, [
                  Vue.h('div', { class: 'title' }, slots.title?.()),
                  Vue.h('div', { class: 'desc' }, slots.desc?.()),
                  Vue.h('div', { class: 'meta' }, slots.meta?.()),
                  Vue.h('div', { class: 'extra' }, slots.extra?.()),
                ]),
            }),
            UiStatusTag: statusTag,
            UiColumnChart: container,
            NuxtLink: nuxtLink,
            WoStatusCapsules: container,
            WoLink: container,
            AButton: button,
            ASpin: container,
          },
        },
      },
    )
    cleanups.push(() => wrapper.unmount())
    await flushPromises()

    // 验证 entities 分页被请求了
    expect(fetchedPages).toContain(1)

    // 验证 help tip 新口径文案
    const text = wrapper.text()
    expect(text).toContain('一单一行；主问题优先级红色工单 → 超期异常 → 停滞红线')
    expect(text).toContain('最多 10 单')
    expect(text).toContain('停滞按 W11 上海自然日计算，包含停工日')
    expect(text).not.toContain('最多 10 条')

    // 验证 also 胶囊存在并渲染了 label 和 duration
    const alsoCapsules = wrapper.findAll('.also-capsule-link')
    expect(alsoCapsules.length).toBeGreaterThanOrEqual(2)

    const capsuleTexts = alsoCapsules.map((c) => c.text())
    // 包含超期异常（已超期 5 天）
    expect(capsuleTexts.some((t) => t.includes('超期异常') && t.includes('已超期 5 天'))).toBe(true)
    // 包含待受理超时异常（不编造天数）
    expect(capsuleTexts.some((t) => t.includes('超期异常') && t.includes('待受理超时'))).toBe(true)
    // 包含同单的停滞红线（已停 12 天）
    expect(capsuleTexts.some((t) => t.includes('停滞红线') && t.includes('已停 12 天'))).toBe(true)

    // 验证 also 胶囊带深链
    const links = alsoCapsules.map((c) => c.attributes('href'))
    expect(links.some((l) => l?.includes('id=issue-1'))).toBe(true)
    expect(links.some((l) => l?.includes('step=step-1'))).toBe(true)
  })
})
