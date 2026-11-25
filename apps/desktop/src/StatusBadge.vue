<script setup lang="ts">
import { computed } from 'vue';
import { statusMeta } from './presentation';
const props = defineProps<{ status: string; compact?: boolean }>();
const state = computed(() => statusMeta(props.status));
</script>
<template><UBadge :color="state.color" variant="subtle" size="sm" class="status-badge" :title="state.label"><UIcon :name="state.icon" class="size-3.5 shrink-0" :class="{ 'animate-spin': ['BUILDING','PLANNING','VALIDATING','REPAIRING','CODE_REVIEW','running'].includes(status) }" /><span v-if="!compact">{{ state.label }}</span></UBadge></template>
