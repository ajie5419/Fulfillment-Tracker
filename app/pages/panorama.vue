<script setup lang="ts">
import { panoramaDestination } from '#shared/panorama'
const route = useRoute()
const ua = import.meta.server ? (useRequestHeaders(['user-agent'])['user-agent'] ?? '') : navigator.userAgent
await navigateTo(panoramaDestination(/Mobile|Android|iPhone|MicroMessenger/i.test(ua), route.query, route.hash), { replace: true })
</script>

<template><div /></template>
