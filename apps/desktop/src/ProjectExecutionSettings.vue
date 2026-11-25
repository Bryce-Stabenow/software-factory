<script setup lang="ts">
import { ref, watch } from 'vue';
import { executionConfigSchema, type ExecutionConfig, type Project } from '../../../packages/contracts/src/index';
const props = defineProps<{ project: Project; busy: boolean }>();
const emit = defineEmits<{ save: [config: ExecutionConfig] }>();
const enabled = ref(false), trusted = ref(false), commands = ref('[]'), error = ref('');
const timeout = ref(15), attempts = ref(2);
watch(() => props.project.config_json, value => {
  const config = JSON.parse(value); enabled.value = config.executionEnabled ?? false; trusted.value = config.trustedRepository ?? false;
  commands.value = JSON.stringify(config.validationCommands ?? [], null, 2); timeout.value = (config.implementationTimeoutMs ?? 900000) / 60000; attempts.value = config.maxImplementationAttempts ?? 2;
}, { immediate: true });
function save() {
  error.value = '';
  try { emit('save', executionConfigSchema.parse({ executionEnabled: enabled.value, trustedRepository: trusted.value, validationCommands: JSON.parse(commands.value), implementationTimeoutMs: Math.round(timeout.value * 60000), maxImplementationAttempts: attempts.value })); }
  catch { error.value = 'Enter a JSON array of named argv commands, valid timeouts, and an implementation attempt limit from 1 to 5.'; }
}
</script>
<template>
  <UCollapsible class="execution-settings"><UButton color="neutral" variant="ghost" trailing-icon="i-lucide-chevron-down">Implementation &amp; validation settings</UButton><template #content><form class="execution-form" @submit.prevent="save">
    <p class="field-note">Each task gets its own branch and worktree. Changes in the main checkout stay there and are not copied into the task branch.</p>
    <UCheckbox v-model="trusted" label="I trust this repository" description="Allow its configured checks to execute code on this computer. Worktrees isolate edits; they do not make untrusted code safe." />
    <USwitch v-model="enabled" :disabled="!trusted" label="Enable implementation" description="Allow implementation after an exact plan approval. Checks have bounded writes, no network access, and a restricted environment." />
    <UFormField label="Validation commands" description="JSON · literal argument arrays"><UTextarea v-model="commands" :rows="7" spellcheck="false" aria-label="Validation commands JSON" class="w-full" /></UFormField>
    <p class="field-note">Example: <code>[{"name":"Tests","argv":["npm","test"],"timeoutMs":60000}]</code>. Dependencies must be available locally. No configured checks blocks code review.</p>
    <div class="form-columns"><UFormField label="Implementation timeout (minutes)"><UInput v-model.number="timeout" type="number" :min="1" :max="30" required class="w-full" /></UFormField><UFormField label="Implementation attempt limit"><UInput v-model.number="attempts" type="number" :min="1" :max="5" required class="w-full" /></UFormField></div>
    <UAlert v-if="error" color="error" variant="subtle" :description="error" /><div><UButton type="submit" size="sm" :disabled="busy || enabled && !trusted">Save execution settings</UButton></div>
  </form></template></UCollapsible>
</template>
