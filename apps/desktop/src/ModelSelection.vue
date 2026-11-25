<script setup lang="ts">
import { computed } from 'vue';
import { modelSelectionItems, encodeModelSelection, decodeModelSelection } from './model-selection';
import type { ProviderHealth } from '../../../packages/contracts/src/index';
const props = defineProps<{ label: string; modelValue: string | null | undefined; health?: ProviderHealth; inherit?: boolean; projectDefault?: string | null; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string | null | undefined] }>();
const choice = computed({
  get: () => encodeModelSelection(props.modelValue),
  set: (value: string) => emit('update:modelValue', decodeModelSelection(value)),
});
const items = computed(() => modelSelectionItems(props.modelValue, props.health?.models, props.inherit, props.projectDefault));
</script>
<template>
  <UFormField :label="label"><USelect v-model="choice" :items="items" :aria-label="label" :disabled="disabled" class="w-full" /><p v-if="!health?.models?.length" class="field-note">Catalog unavailable. Saved selections are retained.</p></UFormField>
</template>
