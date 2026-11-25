<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import ModelSelection from './ModelSelection.vue';
import { defaultAgentSettings, localProjectSettingsSchema, type AgentDefaults, type ProviderHealth, repositoryConfigurationSchema, type RepositoryConfigurationState, type RepositoryConfiguration, type LocalProjectSettings, type Project } from '../../../packages/contracts/src/index';
import { formatCheckCommand, parseCheckCommand, type CheckDraft } from './validation-editor';
import { command } from './api';
const props = defineProps<{ project: Project; busy: boolean; health?: ProviderHealth }>();
const emit = defineEmits<{ refresh: []; save: [settings: { configuration: RepositoryConfiguration; local: LocalProjectSettings; expectedDigest: string | null }] }>();
const state = ref<RepositoryConfigurationState | null>(null), loading = ref(false), error = ref('');
const enabled = ref(false), trusted = ref(false), network = ref(false), networkAllowed = ref(false);
const defaults = ref<AgentDefaults>({ ...defaultAgentSettings });
const tab = ref('local'), formElement = ref<HTMLFormElement>();
const tabs = [{ label: 'Computer permissions & defaults', value: 'local' }, { label: 'Worktree initialization', value: 'worktree_init' }, { label: 'Verification commands', value: 'verification' }];
function tabKey(event: KeyboardEvent, index: number) {
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : -1;
  if (next < 0) return;
  event.preventDefault(); tab.value = tabs[next].value;
  formElement.value?.querySelector<HTMLElement>('#project-tab-' + tab.value)?.focus();
}
async function focusError(panel: string, selector = 'input, select, button') { tab.value = panel; await nextTick(); formElement.value?.querySelector<HTMLElement>(`[data-panel="${panel}"] :is(${selector})`)?.focus(); }
const timeout = ref(15), attempts = ref(2);
const sections = ref<{ key: 'worktree_init' | 'verification'; title: string; description: string; maximum: number; commands: CheckDraft[] }[]>([
  { key: 'worktree_init', title: 'Worktree initialization', description: 'Runs in order when a task worktree is first prepared, before implementation. Install dependencies and prepare ignored local artifacts here. Setup failures pause the task without a code repair.', maximum: 1800, commands: [] },
  { key: 'verification', title: 'Verification', description: 'Runs after implementation and every repair. All commands must succeed on the exact commit before independent review and your acceptance. Verification runs without network access.', maximum: 300, commands: [] },
]);
async function load() {
  loading.value = true; error.value = ''; state.value = null;
  try {
    const result = await command<RepositoryConfigurationState>({ type: 'project.configuration.get', projectId: props.project.id });
    state.value = result;
    defaults.value = { provider: result.local.provider, planningModel: result.local.planningModel, implementationModel: result.local.implementationModel, reviewModel: result.local.reviewModel };
    enabled.value = result.local.executionEnabled; trusted.value = result.local.trustedRepository;
    networkAllowed.value = result.local.initializationNetworkAllowed; network.value = result.configuration?.worktree_init.network ?? false;
    timeout.value = result.local.implementationTimeoutMs / 60000; attempts.value = result.local.maxImplementationAttempts;
    sections.value[0].commands = (result.configuration?.worktree_init.commands ?? []).map(row => ({ name: row.name, command: formatCheckCommand(row.run), timeoutSeconds: row.timeout_seconds }));
    sections.value[1].commands = result.configuration ? result.configuration.verification.commands.map(row => ({ name: row.name, command: formatCheckCommand(row.run), timeoutSeconds: row.timeout_seconds })) : result.legacyVerification.map(row => ({ name: row.name, command: formatCheckCommand(row.argv), timeoutSeconds: row.timeoutMs / 1000 }));
  } catch (cause) { error.value = (cause as Error).message; }
  finally { loading.value = false; }
}
watch(() => props.project.id, load, { immediate: true });
async function save() {
  error.value = '';
  try {
    for (const panel of ['local', 'worktree_init', 'verification']) {
      const invalid = formElement.value?.querySelector<HTMLInputElement>(`[data-panel="${panel}"] input:invalid`);
      if (invalid) { tab.value = panel; await nextTick(); invalid.focus(); invalid.reportValidity(); return; }
    }
    const localResult = localProjectSettingsSchema.safeParse({ ...defaults.value, executionEnabled: enabled.value, trustedRepository: trusted.value, implementationTimeoutMs: Math.round(timeout.value * 60000), maxImplementationAttempts: attempts.value, initializationNetworkAllowed: networkAllowed.value });
    if (!localResult.success) { await focusError('local'); throw new Error('Choose valid defaults, a timeout from 1–30 minutes, and an attempt limit from 1–5.'); }
    const local = localResult.data;
    if (enabled.value && !trusted.value) { await focusError('local'); throw new Error('Trust this repository before enabling implementation.'); }
    if (enabled.value && !sections.value[1].commands.length) { await focusError('verification'); throw new Error('Add a verification command before enabling implementation.'); }
    for (const section of sections.value) {
      const seen = new Set<string>();
      for (const [index, row] of section.commands.entries()) {
        if (!row.name.trim() || row.name.trim().length > 100 || seen.has(row.name.trim())) {
          await focusError(section.key, `fieldset:nth-of-type(${index + 1}) input[aria-label$="name"]`);
          throw new Error('Give each command a unique name of 1–100 characters.');
        }
        seen.add(row.name.trim());
      }
    }
    const rows = (index: number) => sections.value[index].commands.map((row, rowIndex) => {
      try { return { name: row.name.trim(), run: parseCheckCommand(row.command), timeout_seconds: Number(row.timeoutSeconds) }; }
      catch (cause) { void focusError(sections.value[index].key, `fieldset:nth-of-type(${rowIndex + 1}) input[aria-label$="command"]`); throw cause; }
    });
    const parsed = repositoryConfigurationSchema.safeParse({ version: 1, worktree_init: { network: network.value, commands: rows(0) }, verification: { commands: rows(1) } });
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path ?? [];
      const field = path[3] === 'name' ? 'name' : path[3] === 'timeout_seconds' ? 'timeout' : 'command';
      await focusError(String(path[0] ?? 'worktree_init'), typeof path[2] === 'number' ? `fieldset:nth-of-type(${path[2] + 1}) input[aria-label$="${field}"]` : 'input, button'); throw new Error('Give commands unique names and valid timeouts: initialization 0.1–1800 seconds, verification 0.1–300 seconds. Use at most 12 commands per section.'); }
    if (!state.value || state.value.error) throw new Error('Fix the configuration file and reload before saving.');
    emit('save', { configuration: parsed.data, expectedDigest: state.value.digest, local });
  } catch (cause) { error.value = (cause as Error).message; }
}
</script>
<template>
  <form ref="formElement" novalidate class="execution-form project-setup-form" @submit.prevent="save">
    <UAlert color="neutral" variant="subtle" icon="i-lucide-file-code" title="Shared configuration · .kulumin.yml" description="Commands live at the repository root. Save here, then commit the file on your default branch before starting a new worktree. Your trust and permissions stay on this computer." />
    <p v-if="loading" class="field-note">Reading project configuration…</p>
    <template v-if="state">
      <UAlert v-if="state.error" color="error" variant="subtle" title="Configuration could not be read" :description="state.error" />
      <p v-else class="field-note">{{ !state.exists ? 'No file yet. Saving creates .kulumin.yml from these settings.' : !state.committed ? 'The file has uncommitted changes or differs from the default branch. Commit it before execution.' : !state.authorized ? 'Configuration found. Review and save to authorize these commands on this computer.' : 'Reading the committed repository configuration.' }}</p>
      <div role="tablist" aria-label="Project settings" class="project-setup-tabs"><button v-for="(item, index) in tabs" :id="'project-tab-' + item.value" :key="item.value" type="button" role="tab" :aria-selected="tab === item.value" :aria-controls="'project-panel-' + item.value" :tabindex="tab === item.value ? 0 : -1" @click="tab = item.value" @keydown="tabKey($event, index)">{{ item.label }}</button></div>
      <div v-for="section in sections" v-show="tab === section.key" :key="section.key" :data-panel="section.key" :id="'project-panel-' + section.key" role="tabpanel" :aria-labelledby="'project-tab-' + section.key" class="project-settings-panel">
        <div><h3 class="setup-section-title">{{ section.title }}</h3><p class="field-note">{{ section.description }}</p></div>
        <fieldset v-for="(row, index) in section.commands" :key="index" class="validation-command-row" :disabled="busy || loading"><legend>{{ section.title }} {{ index + 1 }}</legend><div class="validation-command-fields"><UFormField label="Name"><UInput v-model="row.name" :aria-label="`${section.title} ${index + 1} name`" required class="w-full" /></UFormField><UFormField label="Command"><UInput v-model="row.command" :placeholder="section.key === 'worktree_init' ? 'npm ci --include=dev' : 'npm test'" :aria-label="`${section.title} ${index + 1} command`" required class="w-full font-mono" /></UFormField><UFormField label="Timeout (seconds)"><UInput v-model.number="row.timeoutSeconds" type="number" :min="0.1" :max="section.maximum" :step="0.1" :aria-label="`${section.title} ${index + 1} timeout`" required class="w-full" /></UFormField><UButton icon="i-lucide-trash-2" color="neutral" variant="ghost" :aria-label="`Remove ${section.title} ${index + 1}`" @click="section.commands.splice(index, 1)" /></div></fieldset>
        <div class="action-row"><UButton size="sm" color="neutral" variant="outline" icon="i-lucide-plus" :disabled="busy || section.commands.length >= 12" @click="section.commands.push({ name: '', command: '', timeoutSeconds: section.key === 'worktree_init' ? 300 : 60 })">Add {{ section.key === 'worktree_init' ? 'initialization' : 'verification' }} command</UButton><UButton v-if="!section.commands.length" size="sm" color="neutral" variant="ghost" :disabled="busy" @click="section.commands.push(section.key === 'worktree_init' ? { name: 'Install dependencies', command: 'npm ci --include=dev', timeoutSeconds: 300 } : { name: 'Tests', command: 'npm test', timeoutSeconds: 300 })">Use npm example</UButton></div>
        <USwitch v-if="section.key === 'worktree_init'" v-model="network" :disabled="busy" label="Initialization needs network access" description="Stored in YAML. Dependency downloads usually need this; execution also requires your permission in Computer permissions & defaults." />
      </div>
      <UCollapsible v-show="tab !== 'local'" class="evidence-disclosure"><UButton color="neutral" variant="ghost" icon="i-lucide-circle-help" trailing-icon="i-lucide-chevron-down" class="disclosure-trigger">How do these commands work?</UButton><template #content><div class="validation-help-body"><p>Git does not copy ignored node_modules into worktrees. For npm projects with a lockfile, use npm ci --include=dev during initialization. Add your repository's existing test, lint and build commands to verification.</p><p>Commands run directly as argument arrays, without shell expansion. Add separate commands instead of chaining with &amp;&amp;. Quote arguments with spaces. For custom setup hooks, invoke a script such as node scripts/setup.mjs. Hooks may prepare ignored files; changing source or HEAD blocks execution.</p><p>Successful initialization is remembered for that worktree and configuration. A failure or interrupted setup is retried on recovery. Use Initialize &amp; revalidate to explicitly repeat successful setup if dependencies were removed.</p><p>Planning works with no commands. Implementation requires at least one verification command. Network permission applies only to initialization; verification stays offline.</p></div></template></UCollapsible>
      <div v-show="tab === 'local'" data-panel="local" id="project-panel-local" role="tabpanel" aria-labelledby="project-tab-local" class="project-settings-panel">
      <UFormField label="Default planner"><USelect v-model="defaults.provider" :items="[{ label: 'Codex', value: 'codex' }, { label: 'Simulation', value: 'fake' }]" :disabled="busy" class="w-full" /></UFormField>
      <ModelSelection :model-value="defaults.planningModel" @update:model-value="defaults.planningModel = $event ?? null" label="Planning model" :health="health" :disabled="busy" />
      <ModelSelection :model-value="defaults.implementationModel" @update:model-value="defaults.implementationModel = $event ?? null" label="Implementation & repair model" :health="health" :disabled="busy" />
      <ModelSelection :model-value="defaults.reviewModel" @update:model-value="defaults.reviewModel = $event ?? null" label="Independent review model" :health="health" :disabled="busy" />
      <UButton color="neutral" variant="ghost" :disabled="busy" @click="emit('refresh')">Refresh models</UButton>
      <p class="field-note">Defaults apply to new task starts. Simulation cannot authorize real execution. Catalog default is selected when each stage runs.</p>
      <div class="setup-divider" /><h3 class="setup-section-title">Permissions on this computer</h3>
      <UCheckbox v-model="trusted" :disabled="busy" label="I trust this repository" description="Allow configured commands to execute project code. Worktrees isolate edits; they do not make untrusted code safe." />
      <UCheckbox v-model="networkAllowed" :disabled="busy || !trusted" label="Allow network access during initialization" description="Required when initialization requests network access in YAML. This permission is local and is never transferred through Git." />
      <USwitch v-model="enabled" :disabled="busy || !trusted" label="Enable implementation after plan approval" description="Code changes still require an explicitly approved real Codex plan." />
      <UAlert v-if="enabled && !sections[1].commands.length" color="warning" variant="subtle" description="Add verification commands before enabling implementation." />
      <div class="form-columns"><UFormField label="Implementation timeout (minutes)"><UInput v-model.number="timeout" type="number" :min="1" :max="30" :disabled="busy" required class="w-full" /></UFormField><UFormField label="Implementation attempt limit"><UInput v-model.number="attempts" type="number" :min="1" :max="5" :disabled="busy" required class="w-full" /></UFormField></div>
      </div>
    </template>
    <UAlert v-if="error" color="error" variant="subtle" :description="error" /><div class="setup-save-row"><UButton color="neutral" variant="ghost" :disabled="busy || loading" @click="load">Reload file</UButton><UButton type="submit" size="sm" :loading="busy" :disabled="loading || !state || !!state.error">Save project settings</UButton></div>
  </form>
</template>
