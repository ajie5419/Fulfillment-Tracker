import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

export const metrics = new Registry()
metrics.setDefaultLabels({ service: 'fulfillment-tracker' })
const options = { registers: [metrics] }
export const errorEvents = new Counter({ ...options, name: 'ft_error_events_total', help: 'Structured errors by bounded event name', labelNames: ['event'] })
export const requestDuration = new Histogram({ ...options, name: 'ft_request_duration_seconds', help: 'HTTP response duration', labelNames: ['status'], buckets: [0.01, 0.05, 0.1, 0.3, 1, 3, 10] })
export const taskLastStart = new Gauge({ ...options, name: 'ft_task_last_start_seconds', help: 'Last scheduled task start', labelNames: ['task'] })
export const taskLastFinish = new Gauge({ ...options, name: 'ft_task_last_finish_seconds', help: 'Last scheduled task finish, success or failure', labelNames: ['task'] })
export const taskRunning = new Gauge({ ...options, name: 'ft_task_running', help: 'Active scheduled task executions', labelNames: ['task'] })
export const heartbeat = new Gauge({ ...options, name: 'ft_observability_heartbeat_seconds', help: 'Last application heartbeat time' })
export function enableProcessMetrics() { collectDefaultMetrics({ register: metrics, prefix: 'ft_' }) }
