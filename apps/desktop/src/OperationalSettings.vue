<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { Diagnostics, StoredExport } from '../../../packages/contracts/src/index';
import { command, nativeDesktop, restartService } from './api';
const emit = defineEmits<{ reload: [] }>();
const report = ref<Diagnostics | null>(null), busy = ref(false), error = ref(''), output = ref<StoredExport | null>(null), backup = ref<StoredExport | null>(null);
async function run(action: () => Promise<void>) {
  if (busy.value) return; busy.value = true; error.value = '';
  try { await action(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
async function inspect() { report.value = await command<Diagnostics>({ type: 'diagnostics.get' }); }
onMounted(() => run(inspect));
const bytes = (value: number) => value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;
</script>
<template>
  <section class="operations-panel">
    <UAlert v-if="error" color="error" variant="subtle" :description="error" />
    <div class="action-row"><UButton color="neutral" variant="outline" size="sm" icon="i-lucide-refresh-cw" :loading="busy" @click="run(inspect)">Refresh diagnostics</UButton><UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-folder-open" :disabled="busy" @click="run(async () => { await command({ type: 'storage.open' }); })">Open data folder</UButton></div>
    <template v-if="report"><div class="operations-metrics"><div class="operation-metric"><span><UIcon name="i-lucide-database" />Database</span><strong>{{ report.storage.integrity }}</strong><small>Schema {{ report.storage.schemaVersion }} · {{ bytes(report.storage.databaseBytes + report.storage.walBytes) }}</small></div><div class="operation-metric"><span><UIcon name="i-lucide-hard-drive" />Free storage</span><strong>{{ report.storage.availableBytes === null ? 'Unavailable' : (report.storage.availableBytes / 1024 ** 3).toFixed(1) + ' GiB' }}</strong><small>Available on the data volume</small></div><div class="operation-metric"><span><UIcon name="i-lucide-activity" />Workers</span><strong>{{ report.counts.runs.running ?? 0 }}</strong><small>{{ report.counts.runs.queued ?? 0 }} queued · {{ report.counts.runs.interrupted ?? 0 }} interrupted</small></div></div>
    <UAlert v-for="notice in report.notices" :key="notice" color="warning" variant="subtle" :description="notice" />
    <div class="surface operations-section"><h3>Local runtime</h3><dl class="artifact-facts"><dt>Version</dt><dd>{{ report.application.version }} · {{ report.application.packaged ? 'Packaged desktop' : 'Development' }}</dd><dt>Platform</dt><dd>{{ report.application.platform }}/{{ report.application.arch }}</dd><dt>Node</dt><dd>{{ report.application.node }} · uptime {{ report.application.uptimeSeconds }} seconds</dd></dl><UCollapsible class="evidence-disclosure mb-0"><UButton color="neutral" variant="ghost" trailing-icon="i-lucide-chevron-down" class="disclosure-trigger">Full diagnostics</UButton><template #content><pre class="raw-evidence">{{ JSON.stringify(report, null, 2) }}</pre></template></UCollapsible></div></template>
    <div class="surface operations-section"><h3>Support report</h3><p>Export versions, storage metrics, status counts, and error codes. Reports exclude repository paths, request text, source, diffs, logs, account details, and credentials.</p><UButton color="neutral" variant="outline" size="sm" icon="i-lucide-file-down" :disabled="busy" @click="run(async () => { output = await command<StoredExport>({ type: 'diagnostics.export' }); await inspect(); })">Export support report</UButton><div v-if="output" class="export-result"><strong><UIcon name="i-lucide-check" />Report saved</strong><code>{{ output.path }}</code><small>{{ bytes(output.bytes) }} · SHA-256 {{ output.sha256 }}</small></div></div>
    <div class="surface operations-section"><h3>Database backup</h3><p>Preserve requests, approvals, and evidence before maintenance. Backups contain private request text, diffs, and logs; keep them private. Repositories and worktrees stay at their existing locations.</p><UButton color="neutral" variant="outline" size="sm" icon="i-lucide-database-backup" :disabled="busy" @click="run(async () => { backup = await command<StoredExport>({ type: 'backup.create' }); })">Create database backup</UButton><div v-if="backup" class="export-result"><strong><UIcon name="i-lucide-check" />Backup saved</strong><code>{{ backup.path }}</code><small>{{ bytes(backup.bytes) }} · SHA-256 {{ backup.sha256 }}</small></div></div>
    <div class="surface operations-section"><h3>Restart service</h3><p>Stop active work and preserve it for explicit recovery. Restarting does not authorize new work.</p><UButton v-if="nativeDesktop" color="neutral" variant="outline" size="sm" icon="i-lucide-power" :disabled="busy" @click="run(async () => { await restartService(); await inspect(); emit('reload'); })">Restart service</UButton><p v-else>For browser development, stop and restart <code>npm run dev</code> in the terminal.</p></div>
  </section>
</template>
