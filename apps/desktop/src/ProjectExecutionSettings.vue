<script setup lang="ts">
import { ref, watch } from 'vue';
import type { ExecutionConfig, Project } from '../../../packages/contracts/src/index';
import { buildExecutionConfig, formatCheckCommand, type CheckDraft } from './validation-editor';
const props = defineProps<{ project: Project; busy: boolean }>();
const emit = defineEmits<{ save: [config: ExecutionConfig] }>();
const enabled = ref(false), trusted = ref(false), checks = ref<CheckDraft[]>([]), error = ref('');
const timeout = ref(15), attempts = ref(2);
const examples = [
  { name: 'Tests', command: 'npm test', description: 'Run your automated tests.' },
  { name: 'Lint', command: 'npm run lint', description: 'Check code style and common mistakes.' },
  { name: 'Build', command: 'npm run build', description: 'Check that the project compiles.' },
];
watch(() => props.project.config_json, value => {
  const config = JSON.parse(value); enabled.value = config.executionEnabled ?? false; trusted.value = config.trustedRepository ?? false;
  checks.value = (config.validationCommands ?? []).map((check: ExecutionConfig['validationCommands'][number]) => ({ name: check.name, command: formatCheckCommand(check.argv), timeoutSeconds: check.timeoutMs / 1000 }));
  timeout.value = (config.implementationTimeoutMs ?? 900000) / 60000; attempts.value = config.maxImplementationAttempts ?? 2;
}, { immediate: true });
function addCheck(name = '', command = '') { checks.value.push({ name, command, timeoutSeconds: 60 }); }
function save() {
  error.value = '';
  try { emit('save', buildExecutionConfig(checks.value, { executionEnabled: enabled.value, trustedRepository: trusted.value, implementationTimeoutMs: Math.round(timeout.value * 60000), maxImplementationAttempts: attempts.value })); }
  catch (cause) { error.value = (cause as Error).message; }
}
</script>
<template>
  <form class="execution-form project-setup-form" @submit.prevent="save">
    <UAlert color="neutral" variant="subtle" icon="i-lucide-route" title="Start with planning, enable implementation when ready" description="You can save requests and start read-only planning now. Code changes require your plan approval and the execution settings below." />
    <div><h3 class="setup-section-title">Validation checks</h3><p class="field-note">These are your project's quality checks. After each implementation or repair, the factory runs every command in the task's isolated worktree. All checks must exit successfully for that exact commit before independent review and your final acceptance. Failures can trigger a bounded repair.</p></div>
    <UCollapsible class="evidence-disclosure validation-help"><UButton color="neutral" variant="ghost" icon="i-lucide-circle-help" trailing-icon="i-lucide-chevron-down" class="disclosure-trigger">Which checks should I add?</UButton><template #content><div class="validation-help-body"><p>Use commands your repository already supports. Tests check behavior, lint checks code quality, and a build checks compilation. A build alone does not prove the behavior is correct.</p><p>Dependencies must already be available in the task worktree. Git does not copy ignored node_modules from your main checkout. For npm projects with a lockfile, prepare that worktree with npm ci --include=dev. The factory does not prepare or install dependencies for you. Checks run without network access. Commands run directly, so add separate checks instead of joining commands with <code>&amp;&amp;</code>. Quote arguments that contain spaces.</p><p>With no checks, the project can still plan, but it cannot complete implementation and review. These examples are suggestions, not commands detected in your repository:</p><div v-for="example in examples" :key="example.name" class="check-example"><div><strong>{{ example.name }}</strong><code>{{ example.command }}</code><p>{{ example.description }}</p></div><UButton size="xs" color="neutral" variant="outline" :disabled="busy || checks.length >= 12" @click="addCheck(example.name, example.command)">Use example</UButton></div></div></template></UCollapsible>
    <div v-if="!checks.length" class="validation-empty"><UIcon name="i-lucide-list-checks" /><div><strong>No checks configured</strong><p>Planning works without them. Add your first check before enabling implementation.</p></div></div>
    <fieldset v-for="(check, index) in checks" :key="index" class="validation-command-row" :disabled="busy"><legend>Check {{ index + 1 }}</legend><div class="validation-command-fields"><UFormField label="Check name"><UInput v-model="check.name" placeholder="Tests" :aria-label="`Check ${index + 1} name`" required class="w-full" /></UFormField><UFormField label="Command"><UInput v-model="check.command" placeholder="npm test" :aria-label="`Check ${index + 1} command`" required class="w-full font-mono" /></UFormField><UFormField label="Timeout (seconds)"><UInput v-model.number="check.timeoutSeconds" type="number" :min="0.1" :max="300" :step="0.1" :aria-label="`Check ${index + 1} timeout`" required class="w-full" /></UFormField><UButton icon="i-lucide-trash-2" color="neutral" variant="ghost" :aria-label="`Remove check ${index + 1}`" :disabled="busy" @click="checks.splice(index, 1)" /></div></fieldset>
    <div><UButton size="sm" color="neutral" variant="outline" icon="i-lucide-plus" :disabled="busy || checks.length >= 12" @click="addCheck()">Add check</UButton></div>
    <div class="setup-divider" /><h3 class="setup-section-title">Execution permissions</h3>
    <UCheckbox v-model="trusted" :disabled="busy" label="I trust this repository" description="Allow its configured checks to execute project code on this computer. Worktrees isolate edits; they do not make untrusted code safe." />
    <USwitch v-model="enabled" :disabled="busy || !trusted" label="Enable implementation after plan approval" description="A real Codex plan must be explicitly approved before any code changes. Checks run with bounded writes, no network access, and a restricted environment." />
    <UAlert v-if="enabled && !checks.length" color="warning" variant="subtle" description="Add at least one check to enable implementation, or switch implementation off to save this project for planning only." />
    <div class="form-columns"><UFormField label="Implementation timeout (minutes)"><UInput v-model.number="timeout" type="number" :min="1" :max="30" :disabled="busy" required class="w-full" /></UFormField><UFormField label="Implementation attempt limit"><UInput v-model.number="attempts" type="number" :min="1" :max="5" :disabled="busy" required class="w-full" /></UFormField></div>
    <UAlert v-if="error" color="error" variant="subtle" :description="error" /><div class="setup-save-row"><span class="field-note">{{ enabled ? 'Execution starts only after your plan approval.' : 'Planning only · code changes stay disabled.' }}</span><UButton type="submit" size="sm" :loading="busy" :disabled="enabled && (!trusted || !checks.length)">{{ enabled ? 'Save execution settings' : 'Save for planning only' }}</UButton></div>
  </form>
</template>
