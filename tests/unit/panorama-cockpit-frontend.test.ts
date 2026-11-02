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

const table = Vue.defineComponent({
  props: ['columns', 'dataSource'],
  setup: (props, { slots }) => () =>
    Vue.h('table', { class: 'stub-table' }, [
      Vue.h('thead', Vue.h('tr', (props.columns ?? []).map((col: any) => Vue.h('th', col.title)))),
      Vue.h(
        'tbody',
        (props.dataSource ?? []).map((record: any) =>
          Vue.h(
            'tr',
            (props.columns ?? []).map((col: any) => {
              const rendered = slots.bodyCell ? slots.bodyCell({ column: col, record }) : null
              const hasVisibleContent =
                rendered &&
                (!Array.isArray(rendered) ||
                  rendered.some((v: any) => v && (typeof v.type !== 'symbol' || v.type.description !== 'v-cmt')))
              return Vue.h('td', hasVisibleContent ? rendered : String(record[col.dataIndex] ?? ''))
            }),
          ),
        ),
      ),
    ]),
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

describe('项目全景页 panorama.vue 结构与数据映射', () => {
  const mockPanoramaData: panoramaShared.PanoramaData = {
    counts: {
      inProgress: 18,
      normal: 12,
      abnormal: 6,
      completed: 45,
      notStarted: 5,
      unaccepted: null,
      unacceptedAvailable: false,
    },
    byManager: [
      { projectManagerId: 'pm1', projectManagerName: '张经理', inProgress: 10, abnormal: 4 },
      { projectManagerId: 'pm2', projectManagerName: '李经理', inProgress: 8, abnormal: 2 },
      { projectManagerId: null, projectManagerName: '未指定项目经理', inProgress: 0, abnormal: 0 },
    ],
    byProductLine: [
      { productLine: '自动化线', inProgress: 12, abnormal: 5 },
      { productLine: null, inProgress: 6, abnormal: 1 },
    ],
  }

  it('正常加载时渲染 6 张数字卡片与两组分布，未验收显示「待接入」、未开工带小字', async () => {
    vi.stubGlobal('useFetch', async () => ({
      data: Vue.ref(mockPanoramaData),
      pending: Vue.ref(false),
      error: Vue.ref(null),
      refresh: vi.fn(),
    }))

    const component = loadComponent('app/pages/panorama.vue', {
      '#shared/panorama': panoramaShared,
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
            UiPageHero: container,
            UiHelpTip: container,
            UiRefreshButton: button,
            UiStatCard: container,
            UiSectionCard: container,
            UiStatusTag: statusTag,
            ATable: table,
            AResult: container,
            AButton: button,
            ASpin: container,
          },
        },
      },
    )
    cleanups.push(() => wrapper.unmount())
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('项目全景')
    expect(text).toContain('在制')
    expect(text).toContain('18')
    expect(text).toContain('正常')
    expect(text).toContain('12')
    expect(text).toContain('异常')
    expect(text).toContain('6')
    expect(text).toContain('完成')
    expect(text).toContain('45')
    expect(text).toContain('未开工')
    expect(text).toContain('5')
    expect(text).toContain('未开工（状态 OPEN）')
    expect(text).toContain('未验收')
    expect(text).toContain('待接入')
    expect(text).toContain('现场验收数据接入后显示')
    // 绝不把未验收显示成 0
    expect(text).not.toContain('未验收 0')

    // 检查分布区映射：null 产品线映射为「未指定产品线」
    expect(text).toContain('自动化线')
    expect(text).toContain('未指定产品线')
    expect(text).toContain('张经理')
    expect(text).toContain('李经理')

    // 异常 > 0 时有异常状态胶囊
    const tags = wrapper.findAll('.ft-status-tag')
    expect(tags.some((t) => t.text().includes('异常 4'))).toBe(true)
    expect(tags.some((t) => t.text().includes('异常 2'))).toBe(true)
    expect(tags.some((t) => t.text().includes('异常 5'))).toBe(true)
  })

  it('接口加载失败时呈现错误态与重试，不显示成一排 0', async () => {
    const refreshMock = vi.fn()
    vi.stubGlobal('useFetch', async () => ({
      data: Vue.ref(null),
      pending: Vue.ref(false),
      error: Vue.ref(new Error('网络超时')),
      refresh: refreshMock,
    }))

    const component = loadComponent('app/pages/panorama.vue', {
      '#shared/panorama': panoramaShared,
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
            UiPageHero: container,
            UiHelpTip: container,
            UiRefreshButton: button,
            UiStatCard: container,
            UiSectionCard: container,
            UiStatusTag: statusTag,
            ATable: table,
            AResult: container,
            AButton: button,
            ASpin: container,
          },
        },
      },
    )
    cleanups.push(() => wrapper.unmount())
    await flushPromises()

    expect(wrapper.text()).toContain('项目全景加载失败')
    expect(wrapper.text()).toContain('网络超时')
    expect(wrapper.find('table').exists()).toBe(false)

    // 点击重试
    const retryBtn = wrapper.findAll('button').find((b) => b.text() === '重试')
    expect(retryBtn).toBeDefined()
    await retryBtn!.trigger('click')
    expect(refreshMock).toHaveBeenCalledTimes(1)
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
    vi.stubGlobal('$fetch', async (url: string, opts: any) => {
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

    vi.stubGlobal('useFetch', async (url: string) => {
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
