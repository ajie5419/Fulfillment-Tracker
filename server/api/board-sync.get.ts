import { syncOverview } from '../services/sync/status'

/** The header only needs current sync failures, independently of work order forecasts. */
export default defineFlowHandler(async () => (await syncOverview()).errors)
