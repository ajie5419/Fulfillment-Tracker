<script setup lang="ts">
/** Flat KPI cards keep attention on real values rather than decorative mini charts. */
import type { RouteLocationRaw } from 'vue-router'
import { NuxtLink } from '#components'

const TICK_COUNT = 28

const props = withDefaults(
  defineProps<{
    label: string
    value?: string | number | null
    unit?: string
    sub?: string
    /** Optional real proportion; raw counts must not imply progress. */
    ratio?: number | null
    tone?: 'late' | 'risk' | 'done' | 'upstream' | 'none' | 'primary'
    accent?: boolean
    icon?: 'alert' | 'warn' | 'check' | 'ring' | 'dot' | null
    to?: RouteLocationRaw
    active?: boolean
    clickable?: boolean
    chip?: boolean
  }>(),
  { value: null, unit: undefined, sub: undefined, ratio: null, tone: undefined, accent: false, icon: null, to: undefined, active: false, clickable: false, chip: false },
)
const emit = defineEmits<{ click: [e: MouseEvent | KeyboardEvent] }>()
const tag = computed(() => (props.to ? NuxtLink : 'div'))
const asButton = computed(() => !props.to && props.clickable)
const CHIP_ICON = { late: 'alert', risk: 'warn', done: 'check', upstream: 'warn', none: 'ring', primary: 'dot' } as const
const headIcon = computed(() => props.icon ?? CHIP_ICON[props.tone ?? 'none'])

const numericValue = computed<number | null>(() => {
  if (typeof props.value === 'number') return Number.isFinite(props.value) ? props.value : null
  if (typeof props.value === 'string') {
    const trimmed = props.value.trim()
    if (!trimmed || trimmed === '—' || trimmed === '-') return null
    const parsed = Number.parseFloat(trimmed.replace(/,/g, ''))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
})

const isZero = computed(() => numericValue.value === 0)

/** A progress indicator is meaningful only when the caller supplies a real ratio. */
const filledTicks = computed(() => {
  if (props.ratio == null || !Number.isFinite(props.ratio)) return 0
  return Math.round(Math.min(1, Math.max(0, props.ratio)) * TICK_COUNT)
})

function onKey(e: KeyboardEvent) {
  if (!asButton.value) return
  e.preventDefault()
  emit('click', e)
}
</script>

<template>
  <component
    :is="tag"
    :to="to"
    class="ft-stat"
    :class="[tone ? `tone-${tone}` : '', { chip, zero: isZero, link: !!to || clickable, active }]"
    :role="asButton ? 'button' : undefined"
    :tabindex="asButton ? 0 : undefined"
    :aria-pressed="asButton ? active : undefined"
    @click="emit('click', $event)"
    @keydown.enter="onKey"
    @keydown.space="onKey"
  >
    <div class="ft-stat-head">
      <span class="ft-stat-iconbox" aria-hidden="true">
        <svg class="ft-stat-glyph" width="13" height="13" viewBox="0 0 16 16" fill="none">
          <template v-if="headIcon === 'alert'">
            <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" />
            <path d="M8 5v3.4M8 10.9h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </template>
          <template v-else-if="headIcon === 'warn'">
            <path d="M8 2.3 14.2 13.2H1.8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
            <path d="M8 6.4v2.8M8 11.2h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </template>
          <template v-else-if="headIcon === 'check'">
            <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" />
            <path d="M5.4 8.2 7.2 10l3.5-3.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </template>
          <template v-else-if="headIcon === 'ring'">
            <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" />
            <path d="M8 4.8V8l2.2 1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </template>
          <template v-else>
            <path d="M2.5 10.8 6.2 7.2l2.4 2.3L13.5 4.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M10.2 4.8h3.3v3.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </template>
        </svg>
      </span>
      <span class="ft-stat-label">{{ label }}</span>
      <svg v-if="to || clickable" class="ft-stat-more" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="3.5" r="1.1" fill="currentColor" />
        <circle cx="8" cy="8" r="1.1" fill="currentColor" />
        <circle cx="8" cy="12.5" r="1.1" fill="currentColor" />
      </svg>
    </div>

    <div class="ft-stat-panel">
      <div v-if="value != null || $slots.value" class="value">
        <slot name="value"><b>{{ value }}</b><span v-if="unit" class="unit">{{ unit }}</span></slot>
      </div>
      <div v-if="ratio != null && Number.isFinite(ratio) && !$slots.value" class="ft-stat-ticks" aria-hidden="true">
        <i
          v-for="n in TICK_COUNT"
          :key="n"
          class="tick"
          :class="{ on: n <= filledTicks }"
        />
      </div>
      <div v-if="sub || $slots.sub || $slots.default" class="sub">
        <slot name="sub">{{ sub }}</slot><slot />
      </div>
    </div>
  </component>
</template>

<style scoped>
.ft-stat {
  --stat-accent: var(--ft-primary);
  --stat-accent-text: var(--ft-primary-text);
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--ft-card-bg);
  background-clip: padding-box;
  border: 1px solid var(--card-hairline);
  border-color: var(--card-hairline-top) var(--card-hairline) var(--card-hairline-bottom);
  border-radius: 16px;
  box-shadow: var(--card-tray-shadow);
  padding: 18px;
  height: 100%;
  box-sizing: border-box;
  color: var(--ft-text);
  min-width: 0;
}
.ft-stat.tone-late { --stat-accent: var(--ft-late); --stat-accent-text: var(--ft-late-text); }
.ft-stat.tone-risk { --stat-accent: var(--ft-risk); --stat-accent-text: var(--ft-risk-text); }
.ft-stat.tone-upstream { --stat-accent: var(--ft-upstream); --stat-accent-text: var(--ft-upstream-text); }
.ft-stat.tone-done { --stat-accent: var(--ft-done); --stat-accent-text: var(--ft-done-text); }
.ft-stat.tone-none { --stat-accent: var(--ft-none); --stat-accent-text: var(--ft-text-2); }

.ft-stat-head { display: flex; align-items: center; gap: 8px; padding: 0 0 20px; flex: none; min-width: 0; }
.ft-stat-iconbox {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: var(--card-keycap-surface);
  background-clip: padding-box;
  border: 1px solid var(--card-hairline);
  border-color: var(--card-hairline-top) var(--card-hairline) var(--card-hairline-bottom);
  box-shadow: var(--card-keycap-shadow);
  color: var(--ft-text-2);
}
.ft-stat:not(.zero).tone-late .ft-stat-iconbox { color: var(--ft-late-text); }
.ft-stat:not(.zero).tone-risk .ft-stat-iconbox { color: var(--ft-risk-text); }
.ft-stat:not(.zero).tone-upstream .ft-stat-iconbox { color: var(--ft-upstream-text); }
.ft-stat:not(.zero).tone-done .ft-stat-iconbox { color: var(--ft-done-text); }

.ft-stat-label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--ft-text-2);
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ft-stat-more { flex: none; color: var(--ft-text-3); opacity: 0.6; transition: opacity 0.15s, color 0.15s; }

.ft-stat-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  background: transparent;
  background-clip: padding-box;
  border: none;
  padding: 0;
  min-width: 0;
}

.ft-stat.link { cursor: pointer; transition: border-color 0.16s, box-shadow 0.16s, background 0.16s; }
.ft-stat.link:hover {
  color: var(--ft-text);
  border-color: var(--card-hairline-hover-top) var(--card-hairline-hover) var(--card-hairline-hover-bottom);
  box-shadow: var(--card-shadow-hover);
}
.ft-stat.link:hover .ft-stat-label { color: var(--ft-text); }
.ft-stat.link:hover .ft-stat-more { opacity: 1; color: var(--ft-text-2); }
.ft-stat.active { border-color: var(--ft-primary); background: var(--ft-primary-bg); box-shadow: var(--card-tray-shadow); }
.ft-stat.active .ft-stat-label { color: var(--ft-primary-text); font-weight: 600; }
.ft-stat.active .ft-stat-iconbox { color: var(--ft-primary-text); border-color: color-mix(in srgb, var(--ft-primary) 28%, var(--ft-border)); }
.ft-stat.link:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; }

.value { line-height: 1.12; font-variant-numeric: tabular-nums; }
.value b { font-size: 26px; font-weight: 600; letter-spacing: -0.025em; font-variant-numeric: tabular-nums; color: var(--ft-text); }
.unit { margin-left: 6px; font-size: 13px; font-weight: 500; color: var(--ft-text-2); }
.tone-late:not(.zero) .value b { color: var(--ft-late-text); }

.ft-stat-ticks {
  display: grid;
  grid-template-columns: repeat(28, minmax(0, 1fr));
  gap: 3px;
  height: 10px;
  margin-top: 11px;
}
.tick {
  display: block;
  border-radius: 1.5px;
  background: var(--ft-border);
  opacity: 0.72;
}
.tick.on {
  opacity: 1;
  background: color-mix(in srgb, var(--stat-accent) var(--w, 90%), var(--ft-card-bg));
}

.sub {
  margin-top: 8px;
  font-size: 12px;
  color: var(--ft-text-3);
  line-height: 1.4;
}
.sub-arrow {
  margin-right: 4px;
  font-weight: 600;
  color: var(--stat-accent-text);
}
.ft-stat:not(.zero):is(.tone-late, .tone-risk, .tone-done, .tone-upstream) .sub { color: var(--ft-text-2); }
.ft-stat.active .sub { color: var(--ft-text-2); }
</style>
