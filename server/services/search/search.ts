/**
 * 全局搜索（借鉴 ERPNext 顶部"搜索一切"，10-26）：工单号 / 项目名、工件名 / 图号、采购物料 / 供应商、外协厂 / 班组。
 * 只做"包含"匹配，每类最多几条，点开跳到对应页面；只搜可见工单（项目经理只看本人工单）。
 */
import { prisma } from '../../utils/prisma'

const LIMIT = 6

export interface SearchHit {
  type: 'workOrder' | 'part' | 'purchase' | 'supplier'
  id: string
  title: string
  sub: string
  link: string
}

const enc = encodeURIComponent

export async function search(q: string, visibleWorkOrders?: string[]): Promise<SearchHit[]> {
  const kw = q.trim()
  if (kw.length < 2) return []
  const wo = visibleWorkOrders ? { in: visibleWorkOrders } : undefined
  const [orders, parts, lines, suppliers] = await Promise.all([
    prisma.qmsWorkOrder.findMany({
      where: {
        isDeleted: false,
        ...(wo ? { workOrderNumber: wo } : {}),
        OR: [{ workOrderNumber: { contains: kw } }, { projectName: { contains: kw } }, { customerName: { contains: kw } }],
      },
      orderBy: { deliveryDate: 'asc' },
      take: LIMIT,
      select: { workOrderNumber: true, projectName: true, customerName: true },
    }),
    prisma.part.findMany({
      where: { ...(wo ? { workOrderNumber: wo } : {}), OR: [{ name: { contains: kw } }, { drawingNo: { contains: kw } }] },
      orderBy: { createdAt: 'desc' },
      take: LIMIT,
      select: { id: true, name: true, drawingNo: true, workOrderNumber: true },
    }),
    prisma.purchaseLine.findMany({
      where: { ...(wo ? { workOrderNumber: wo } : {}), OR: [{ materialName: { contains: kw } }, { supplierName: { contains: kw } }, { spec: { contains: kw } }] },
      orderBy: { needDate: 'asc' },
      take: LIMIT,
      select: { id: true, materialName: true, spec: true, supplierName: true, workOrderNumber: true, status: true },
    }),
    prisma.qmsSupplier.findMany({ where: { isDeleted: false, name: { contains: kw } }, orderBy: { name: 'asc' }, take: LIMIT, select: { id: true, name: true, kind: true } }),
  ])
  // 外协厂 / 班组：附上手上（在外 / 加工中）的工序数
  const busy = suppliers.length
    ? await prisma.routeStep.groupBy({
        by: ['supplierId'],
        where: { supplierId: { in: suppliers.map((s) => s.id) }, status: { in: ['OUT', 'IN_PROGRESS'] }, ...(wo ? { part: { workOrderNumber: wo } } : {}) },
        _count: { _all: true },
      })
    : []
  const busyOf = new Map(busy.map((b) => [b.supplierId, b._count._all]))
  return [
    ...orders.map((o) => ({ type: 'workOrder' as const, id: o.workOrderNumber, title: o.workOrderNumber, sub: o.projectName ?? o.customerName, link: `/wo/${enc(o.workOrderNumber)}` })),
    ...parts.map((p) => ({
      type: 'part' as const,
      id: p.id,
      title: p.name,
      sub: `${p.workOrderNumber}${p.drawingNo ? ` · 图号 ${p.drawingNo}` : ''}`,
      link: `/parts?wo=${enc(p.workOrderNumber)}&part=${enc(p.id)}`,
    })),
    ...lines.map((l) => ({
      type: 'purchase' as const,
      id: l.id,
      title: `${l.materialName}${l.spec ? ` ${l.spec}` : ''}`,
      sub: `${l.workOrderNumber}${l.supplierName ? ` · ${l.supplierName}` : ''}${l.status === 'ARRIVED' ? ' · 已到货' : ''}`,
      link: `/purchases?wo=${enc(l.workOrderNumber)}&id=${enc(l.id)}`,
    })),
    ...suppliers.map((s) => ({
      type: 'supplier' as const,
      id: s.id,
      title: s.name,
      sub: `${s.kind === 'TEAM' ? '厂内班组' : '外协厂'} · 手上 ${busyOf.get(s.id) ?? 0} 道工序`,
      link: `/workshop?supplierId=${enc(s.id)}`,
    })),
  ]
}
