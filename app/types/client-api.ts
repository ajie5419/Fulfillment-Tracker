import type { EventHandler } from 'h3'
import type { Serialize } from 'nitropack/types'
import type { z } from 'zod'

type Endpoint<H extends EventHandler, B = never, Q = never> = { response: Serialize<Awaited<ReturnType<H>>>; body: B; query: Q }

/** 仅类型：响应取自端点，输入取自端点原有 schema；不引入服务端运行时代码。 */
export interface ClientApi {
  '/api/alerts/:id/convert': { POST: Endpoint<typeof import('../../server/api/alerts/[id]/convert.post').default, never, never> }
  '/api/alerts': { GET: Endpoint<typeof import('../../server/api/alerts/index.get').default, never, import('../../server/api/alerts/index.get').RequestQuery> }
  '/api/bom/excel': { POST: Endpoint<typeof import('../../server/api/bom/excel.post').default, FormData, never> }
  '/api/bom/import': { POST: Endpoint<typeof import('../../server/api/bom/import.post').default, import('../../server/api/bom/import.post').RequestBody, never> }
  '/api/bom/preview': { GET: Endpoint<typeof import('../../server/api/bom/preview.get').default, never, import('../../server/api/bom/preview.get').RequestQuery> }
  '/api/bom/text': { POST: Endpoint<typeof import('../../server/api/bom/text.post').default, import('../../server/api/bom/text.post').RequestBody, never> }
  '/api/dev/digest': { POST: Endpoint<typeof import('../../server/api/dev/digest.post').default, never, never> }
  '/api/dev/inspections/:id/verdict': { POST: Endpoint<typeof import('../../server/api/dev/inspections/[id]/verdict.post').default, import('../../server/api/dev/inspections/[id]/verdict.post').RequestBody, never> }
  '/api/dev/inspections': { GET: Endpoint<typeof import('../../server/api/dev/inspections.get').default, never, never>; POST: Endpoint<typeof import('../../server/api/dev/inspections.post').default, import('../../server/api/dev/inspections.post').RequestBody, never> }
  '/api/dev/match': { POST: Endpoint<typeof import('../../server/api/dev/match.post').default, never, never> }
  '/api/dev/reset': { POST: Endpoint<typeof import('../../server/api/dev/reset.post').default, never, never> }
  '/api/dev/scan': { POST: Endpoint<typeof import('../../server/api/dev/scan.post').default, import('../../server/api/dev/scan.post').RequestBody, never> }
  '/api/dev/seed': { POST: Endpoint<typeof import('../../server/api/dev/seed.post').default, never, never> }
  '/api/dev/sync': { POST: Endpoint<typeof import('../../server/api/dev/sync.post').default, never, never> }
  '/api/drawings/:id/confirm': { POST: Endpoint<typeof import('../../server/api/drawings/[id]/confirm.post').default, z.input<typeof import('../../server/schemas/drawings').dateBody>, never> }
  '/api/drawings/:id/drawn': { POST: Endpoint<typeof import('../../server/api/drawings/[id]/drawn.post').default, z.input<typeof import('../../server/schemas/drawings').dateBody>, never> }
  '/api/drawings/:id/undo-confirm': { POST: Endpoint<typeof import('../../server/api/drawings/[id]/undo-confirm.post').default, never, never> }
  '/api/drawings/:id/undo-drawn': { POST: Endpoint<typeof import('../../server/api/drawings/[id]/undo-drawn.post').default, never, never> }
  '/api/drawings/:id': { GET: Endpoint<typeof import('../../server/api/drawings/[id].get').default, never, never>; PATCH: Endpoint<typeof import('../../server/api/drawings/[id].patch').default, z.input<typeof import('../../server/schemas/drawings').patchTaskBody>, never> }
  '/api/drawings': { GET: Endpoint<typeof import('../../server/api/drawings/index.get').default, never, z.input<typeof import('../../server/schemas/drawings').listQuery>>; POST: Endpoint<typeof import('../../server/api/drawings/index.post').default, z.input<typeof import('../../server/schemas/drawings').newTaskBody>, never> }
  '/api/drawings/load': { GET: Endpoint<typeof import('../../server/api/drawings/load.get').default, never, z.input<typeof import('../../server/schemas/drawings').loadQuery>> }
  '/api/issues/:id/accept': { POST: Endpoint<typeof import('../../server/api/issues/[id]/accept.post').default, import('../../server/api/issues/[id]/accept.post').RequestBody, never> }
  '/api/issues/:id/close': { POST: Endpoint<typeof import('../../server/api/issues/[id]/close.post').default, z.input<typeof import('../../server/schemas/issues').optionalNoteBody>, never> }
  '/api/issues/:id/note': { POST: Endpoint<typeof import('../../server/api/issues/[id]/note.post').default, z.input<typeof import('../../server/schemas/issues').noteBody>, never> }
  '/api/issues/:id/reassign': { POST: Endpoint<typeof import('../../server/api/issues/[id]/reassign.post').default, import('../../server/api/issues/[id]/reassign.post').RequestBody, never> }
  '/api/issues/:id/reject': { POST: Endpoint<typeof import('../../server/api/issues/[id]/reject.post').default, z.input<typeof import('../../server/schemas/issues').noteBody>, never> }
  '/api/issues/:id/resolve': { POST: Endpoint<typeof import('../../server/api/issues/[id]/resolve.post').default, z.input<typeof import('../../server/schemas/issues').noteBody>, never> }
  '/api/issues/:id': { GET: Endpoint<typeof import('../../server/api/issues/[id].get').default, never, never> }
  '/api/issues': { GET: Endpoint<typeof import('../../server/api/issues/index.get').default, never, import('../../server/api/issues/index.get').RequestQuery>; POST: Endpoint<typeof import('../../server/api/issues/index.post').default, import('../../server/api/issues/index.post').RequestBody, never> }
  '/api/issues/options': { GET: Endpoint<typeof import('../../server/api/issues/options.get').default, never, never> }
  '/api/kitting/:id': { DELETE: Endpoint<typeof import('../../server/api/kitting/[id].delete').default, never, never>; GET: Endpoint<typeof import('../../server/api/kitting/[id].get').default, never, never>; PATCH: Endpoint<typeof import('../../server/api/kitting/[id].patch').default, z.input<typeof import('../../server/schemas/kitting').patchNodeBody>, never> }
  '/api/kitting': { GET: Endpoint<typeof import('../../server/api/kitting/index.get').default, never, z.input<typeof import('../../server/schemas/kitting').listQuery>>; POST: Endpoint<typeof import('../../server/api/kitting/index.post').default, z.input<typeof import('../../server/schemas/kitting').newNodeBody>, never> }
  '/api/kitting/options': { GET: Endpoint<typeof import('../../server/api/kitting/options.get').default, never, z.input<typeof import('../../server/schemas/kitting').optionsQuery>> }
  '/api/parts/:id/apply-template': { POST: Endpoint<typeof import('../../server/api/parts/[id]/apply-template.post').default, import('../../server/api/parts/[id]/apply-template.post').RequestBody, never> }
  '/api/parts/:id/save-template': { POST: Endpoint<typeof import('../../server/api/parts/[id]/save-template.post').default, import('../../server/api/parts/[id]/save-template.post').RequestBody, never> }
  '/api/payments/:id/status': { POST: Endpoint<typeof import('../../server/api/payments/[id]/status.post').default, z.input<typeof import('../../server/schemas/purchases').paymentStatusBody>, never> }
  '/api/payments/:id': { DELETE: Endpoint<typeof import('../../server/api/payments/[id].delete').default, never, never> }
  '/api/payments': { GET: Endpoint<typeof import('../../server/api/payments/index.get').default, never, z.input<typeof import('../../server/schemas/purchases').paymentQuery>>; POST: Endpoint<typeof import('../../server/api/payments/index.post').default, z.input<typeof import('../../server/schemas/purchases').newPaymentBody>, never> }
  '/api/payments/stats': { GET: Endpoint<typeof import('../../server/api/payments/stats.get').default, never, import('../../server/api/payments/stats.get').RequestQuery> }
  '/api/plan/dept': { GET: Endpoint<typeof import('../../server/api/plan/dept.get').default, never, z.input<typeof import('../../server/schemas/plan').deptPlanQuery>> }
  '/api/plan/generate': { POST: Endpoint<typeof import('../../server/api/plan/generate.post').default, z.input<typeof import('../../server/schemas/plan').generateBody>, never> }
  '/api/plan': { GET: Endpoint<typeof import('../../server/api/plan/index.get').default, never, z.input<typeof import('../../server/schemas/plan').woQuery>> }
  '/api/plan/list': { GET: Endpoint<typeof import('../../server/api/plan/list.get').default, never, import('../../server/api/plan/list.get').RequestQuery> }
  '/api/plan/nodes/:id/complete': { POST: Endpoint<typeof import('../../server/api/plan/nodes/[id]/complete.post').default, z.input<typeof import('../../server/schemas/plan').completeBody>, never> }
  '/api/plan/nodes/:id/confirm': { POST: Endpoint<typeof import('../../server/api/plan/nodes/[id]/confirm.post').default, never, never> }
  '/api/plan/nodes/:id/reject': { POST: Endpoint<typeof import('../../server/api/plan/nodes/[id]/reject.post').default, z.input<typeof import('../../server/schemas/plan').rejectBody>, never> }
  '/api/plan/nodes/:id/steps': { GET: Endpoint<typeof import('../../server/api/plan/nodes/[id]/steps.get').default, never, never>; POST: Endpoint<typeof import('../../server/api/plan/nodes/[id]/steps.post').default, z.input<typeof import('../../server/schemas/plan').linkStepsBody>, never> }
  '/api/plan/nodes/:id/tasks': { POST: Endpoint<typeof import('../../server/api/plan/nodes/[id]/tasks.post').default, z.input<typeof import('../../server/schemas/plan').newTaskBody>, never> }
  '/api/plan/nodes/:id/undo-complete': { POST: Endpoint<typeof import('../../server/api/plan/nodes/[id]/undo-complete.post').default, never, never> }
  '/api/plan/nodes/:id': { DELETE: Endpoint<typeof import('../../server/api/plan/nodes/[id].delete').default, z.input<typeof import('../../server/schemas/plan').deleteNodeBody>, never>; PATCH: Endpoint<typeof import('../../server/api/plan/nodes/[id].patch').default, z.input<typeof import('../../server/schemas/plan').patchNodeBody>, never> }
  '/api/plan/nodes': { POST: Endpoint<typeof import('../../server/api/plan/nodes/index.post').default, z.input<typeof import('../../server/schemas/plan').newNodeBody>, never> }
  '/api/plan/options': { GET: Endpoint<typeof import('../../server/api/plan/options.get').default, never, z.input<typeof import('../../server/schemas/plan').woQuery>> }
  '/api/plan/publish': { POST: Endpoint<typeof import('../../server/api/plan/publish.post').default, z.input<typeof import('../../server/schemas/plan').woBody>, never> }
  '/api/plan/tasks/:id/complete': { POST: Endpoint<typeof import('../../server/api/plan/tasks/[id]/complete.post').default, z.input<typeof import('../../server/schemas/plan').completeBody>, never> }
  '/api/plan/tasks/:id/undo-complete': { POST: Endpoint<typeof import('../../server/api/plan/tasks/[id]/undo-complete.post').default, never, never> }
  '/api/plan/tasks/:id': { DELETE: Endpoint<typeof import('../../server/api/plan/tasks/[id].delete').default, never, never>; PATCH: Endpoint<typeof import('../../server/api/plan/tasks/[id].patch').default, z.input<typeof import('../../server/schemas/plan').patchTaskBody>, never> }
  '/api/plan/templates/:id': { DELETE: Endpoint<typeof import('../../server/api/plan/templates/[id].delete').default, never, never>; PUT: Endpoint<typeof import('../../server/api/plan/templates/[id].put').default, z.input<typeof import('../../server/schemas/plan').templateBody>, never> }
  '/api/plan/templates': { GET: Endpoint<typeof import('../../server/api/plan/templates/index.get').default, never, never>; POST: Endpoint<typeof import('../../server/api/plan/templates/index.post').default, z.input<typeof import('../../server/schemas/plan').templateBody>, never> }
  '/api/process/:id/action': { POST: Endpoint<typeof import('../../server/api/process/[id]/action.post').default, z.input<typeof import('../../server/schemas/process').actionBody>, never> }
  '/api/process/:id/logs': { GET: Endpoint<typeof import('../../server/api/process/[id]/logs.get').default, never, never> }
  '/api/process': { GET: Endpoint<typeof import('../../server/api/process/index.get').default, never, z.input<typeof import('../../server/schemas/process').listQuery>> }
  '/api/purchase-plans/:id/convert': { POST: Endpoint<typeof import('../../server/api/purchase-plans/[id]/convert.post').default, z.input<typeof import('../../server/schemas/purchase-plans').convertPlanBody>, never> }
  '/api/purchase-plans/:id/issue': { POST: Endpoint<typeof import('../../server/api/purchase-plans/[id]/issue.post').default, never, never> }
  '/api/purchase-plans/:id/items/:itemId': { DELETE: Endpoint<typeof import('../../server/api/purchase-plans/[id]/items/[itemId].delete').default, never, never>; PATCH: Endpoint<typeof import('../../server/api/purchase-plans/[id]/items/[itemId].patch').default, z.input<typeof import('../../server/schemas/purchase-plans').planItemBody>, never> }
  '/api/purchase-plans/:id/items': { POST: Endpoint<typeof import('../../server/api/purchase-plans/[id]/items.post').default, z.input<typeof import('../../server/schemas/purchase-plans').planItemBody>, never> }
  '/api/purchase-plans/:id/withdraw': { POST: Endpoint<typeof import('../../server/api/purchase-plans/[id]/withdraw.post').default, never, never> }
  '/api/purchase-plans/:id': { GET: Endpoint<typeof import('../../server/api/purchase-plans/[id].get').default, never, never>; PATCH: Endpoint<typeof import('../../server/api/purchase-plans/[id].patch').default, z.input<typeof import('../../server/schemas/purchase-plans').planHeadBody>, never> }
  '/api/purchase-plans': { GET: Endpoint<typeof import('../../server/api/purchase-plans/index.get').default, never, z.input<typeof import('../../server/schemas/purchase-plans').planListQuery>>; POST: Endpoint<typeof import('../../server/api/purchase-plans/index.post').default, z.input<typeof import('../../server/schemas/purchase-plans').newPlanBody>, never> }
  '/api/purchases/:id/arrive': { POST: Endpoint<typeof import('../../server/api/purchases/[id]/arrive.post').default, z.input<typeof import('../../server/schemas/purchases').arriveBody>, never> }
  '/api/purchases/:id/undo-arrival': { POST: Endpoint<typeof import('../../server/api/purchases/[id]/undo-arrival.post').default, never, never> }
  '/api/purchases/:id': { DELETE: Endpoint<typeof import('../../server/api/purchases/[id].delete').default, never, never>; GET: Endpoint<typeof import('../../server/api/purchases/[id].get').default, never, never>; PATCH: Endpoint<typeof import('../../server/api/purchases/[id].patch').default, z.input<typeof import('../../server/schemas/purchases').patchLineBody>, never> }
  '/api/purchases/import': { POST: Endpoint<typeof import('../../server/api/purchases/import.post').default, FormData, never> }
  '/api/purchases': { GET: Endpoint<typeof import('../../server/api/purchases/index.get').default, never, z.input<typeof import('../../server/schemas/purchases').listQuery>>; POST: Endpoint<typeof import('../../server/api/purchases/index.post').default, z.input<typeof import('../../server/schemas/purchases').newLineBody>, never> }
  '/api/purchases/options': { GET: Endpoint<typeof import('../../server/api/purchases/options.get').default, never, z.input<typeof import('../../server/schemas/purchases').purchaseOptionsQuery>> }
  '/api/purchases/template': { GET: Endpoint<typeof import('../../server/api/purchases/template.get').default, never, never> }
  '/api/receipts/:id/reject': { POST: Endpoint<typeof import('../../server/api/receipts/[id]/reject.post').default, z.input<typeof import('../../server/schemas/releases').rejectBody>, never> }
  '/api/receipts/:id/sign': { POST: Endpoint<typeof import('../../server/api/receipts/[id]/sign.post').default, never, never> }
  '/api/receipts': { GET: Endpoint<typeof import('../../server/api/receipts/index.get').default, never, import('../../server/api/receipts/index.get').RequestQuery> }
  '/api/releases/:id/confirm-change': { POST: Endpoint<typeof import('../../server/api/releases/[id]/confirm-change.post').default, z.input<typeof import('../../server/schemas/releases').confirmBody>, never> }
  '/api/releases/:id/void': { POST: Endpoint<typeof import('../../server/api/releases/[id]/void.post').default, never, never> }
  '/api/releases/:id': { GET: Endpoint<typeof import('../../server/api/releases/[id].get').default, never, never> }
  '/api/releases': { GET: Endpoint<typeof import('../../server/api/releases/index.get').default, never, import('../../server/api/releases/index.get').RequestQuery>; POST: Endpoint<typeof import('../../server/api/releases/index.post').default, z.input<typeof import('../../server/schemas/releases').newReleaseBody>, never> }
  '/api/releases/stats': { GET: Endpoint<typeof import('../../server/api/releases/stats.get').default, never, import('../../server/api/releases/stats.get').RequestQuery> }
  '/api/settings/dept-mappings/:id': { PUT: Endpoint<typeof import('../../server/api/settings/dept-mappings/[id].put').default, import('../../server/api/settings/dept-mappings/[id].put').RequestBody, never> }
  '/api/settings': { GET: Endpoint<typeof import('../../server/api/settings/index.get').default, never, never> }
  '/api/settings/off-days/:date': { DELETE: Endpoint<typeof import('../../server/api/settings/off-days/[date].delete').default, never, never> }
  '/api/settings/off-days': { POST: Endpoint<typeof import('../../server/api/settings/off-days/index.post').default, import('../../server/api/settings/off-days/index.post').RequestBody, never> }
  '/api/settings/roles/:id': { DELETE: Endpoint<typeof import('../../server/api/settings/roles/[id].delete').default, never, never> }
  '/api/settings/roles': { POST: Endpoint<typeof import('../../server/api/settings/roles/index.post').default, import('../../server/api/settings/roles/index.post').RequestBody, never> }
  '/api/settings/sync': { GET: Endpoint<typeof import('../../server/api/settings/sync.get').default, never, never> }
  '/api/settings/thresholds/:rule': { PUT: Endpoint<typeof import('../../server/api/settings/thresholds/[rule].put').default, import('../../server/api/settings/thresholds/[rule].put').RequestBody, never> }
  '/api/settings/work-orders/:wo': { PUT: Endpoint<typeof import('../../server/api/settings/work-orders/[wo].put').default, import('../../server/api/settings/work-orders/[wo].put').RequestBody, never> }
  '/api/team-leaders/:teamId': { PUT: Endpoint<typeof import('../../server/api/team-leaders/[teamId].put').default, import('../../server/api/team-leaders/[teamId].put').RequestBody, never> }
  '/api/team-leaders': { GET: Endpoint<typeof import('../../server/api/team-leaders/index.get').default, never, never> }
  '/api/templates/:id': { DELETE: Endpoint<typeof import('../../server/api/templates/[id].delete').default, never, never>; PUT: Endpoint<typeof import('../../server/api/templates/[id].put').default, z.input<typeof import('../../server/schemas/templates').templateBody>, never> }
  '/api/templates': { GET: Endpoint<typeof import('../../server/api/templates/index.get').default, never, never>; POST: Endpoint<typeof import('../../server/api/templates/index.post').default, z.input<typeof import('../../server/schemas/templates').templateBody>, never> }
  '/api/uploads': { POST: Endpoint<typeof import('../../server/api/uploads.post').default, FormData, import('../../server/api/uploads.post').RequestQuery> }
}
