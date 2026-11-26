<script setup lang="ts">
import { computed } from 'vue';
import DiffViewer from './DiffViewer.vue';
import { hasDiffContent, parseDiff, reconcileSelectedFile } from './diff-view';
const props = defineProps<{ diff: string; changedFiles: string[]; source: 'workspace' | 'evidence'; selectedFile: string | null; mode: 'inline' | 'side-by-side'; truncated?: boolean; loading?: boolean; error?: string; base?: string; commit?: string }>();
const emit = defineEmits<{ select: [file: string]; mode: [mode: 'inline' | 'side-by-side'] }>();
const files = computed(() => parseDiff(props.diff, props.changedFiles));
const selected = computed(() => files.value.find(file => file.path === reconcileSelectedFile(files.value, props.selectedFile)));
</script>
<template>
  <section class="diff-panel">
    <div class="diff-panel-heading"><div><h3>Diff</h3><p>{{ source === 'evidence' ? 'Reviewed evidence — captured commit' : 'Current worktree changes' }}</p></div><div class="diff-mode" role="group" aria-label="Diff display mode"><button :class="{ active: mode === 'inline' }" :aria-pressed="mode === 'inline'" @click="emit('mode', 'inline')">Inline</button><button :class="{ active: mode === 'side-by-side' }" :aria-pressed="mode === 'side-by-side'" @click="emit('mode', 'side-by-side')">Side-by-side</button></div></div>
    <dl v-if="base || commit" class="diff-labels"><dt>Base</dt><dd>{{ base ?? 'Unknown' }}</dd><dt>Commit</dt><dd>{{ commit ?? 'Current worktree' }}</dd></dl>
    <p v-if="loading" class="field-note">Inspecting worktree changes…</p><UAlert v-else-if="error" color="error" variant="subtle" :description="error" />
    <template v-else-if="files.length"><div class="diff-browser"><nav class="diff-files" aria-label="Changed files"><button v-for="file in files" :key="file.path" :class="{ selected: selected?.path === file.path }" :aria-current="selected?.path === file.path ? 'true' : undefined" @click="emit('select', file.path)"><UIcon name="i-lucide-file-code" />{{ file.path }}<small v-if="file.unavailable">Unavailable</small><small v-else-if="file.binary">Binary</small></button></nav><div class="diff-file"><header><strong>{{ selected?.path }}</strong><span v-if="truncated" class="field-note">Capture truncated</span></header><p v-if="selected?.unavailable" class="diff-state">No patch was captured for this file (for example, an untracked file).</p><p v-else-if="selected?.binary" class="diff-state">This binary change cannot be rendered as a text comparison.</p><p v-else-if="!selected || !hasDiffContent(selected)" class="diff-state">No text changes are available for this file.</p><DiffViewer v-else :section="selected" :mode="mode" /></div></div><p v-if="truncated" class="field-note">Only the captured portion is available. Open the worktree for the full diff.</p></template>
    <div v-else-if="source === 'workspace' && !changedFiles.length" class="tab-empty"><h3>No changes</h3><p>The inspected worktree has no changes from its base.</p></div><div v-else-if="truncated" class="tab-empty"><h3>Diff capture incomplete</h3><p>Only part of this diff was captured, and no file patch is available to display. Open the worktree for the full diff.</p></div><div v-else class="tab-empty"><h3>Diff unavailable</h3><p>No captured patch is available for this source.</p></div>
  </section>
</template>