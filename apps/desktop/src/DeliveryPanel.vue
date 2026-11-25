<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { DeliveryDetails, Task } from '../../../packages/contracts/src/index';
import { command } from './api';
const props = defineProps<{ task: Task }>();
const emit = defineEmits<{ changed: [] }>();
const details = ref<DeliveryDetails | null>(null), remote = ref(''), busy = ref(false), error = ref(''), success = ref('');
async function refresh() {
  details.value = await command<DeliveryDetails>({ type: 'delivery.inspect', taskId: props.task.id });
  if (!details.value.remotes.includes(remote.value)) remote.value = details.value.remotes.includes('origin') ? 'origin' : details.value.remotes[0] ?? '';
}
async function run(action: 'refresh' | 'merge' | 'task' | 'default') {
  if (busy.value) return;
  busy.value = true; error.value = ''; success.value = '';
  try {
    if (action === 'merge' && details.value) {
      await command({ type: 'delivery.merge', taskId: props.task.id, expectedVersion: props.task.version, expectedHead: props.task.accepted_commit_sha!, expectedDefaultHead: details.value.defaultHead });
      emit('changed');
    } else if ((action === 'task' || action === 'default') && details.value) {
      await command({ type: 'delivery.push', taskId: props.task.id, expectedVersion: props.task.version, target: action, remote: remote.value, expectedHead: action === 'task' ? props.task.accepted_commit_sha! : details.value.defaultHead });
      success.value = `Pushed ${action === 'task' ? details.value.taskBranch : details.value.defaultBranch} to ${remote.value}.`;
      emit('changed');
    }
    await refresh();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
onMounted(() => run('refresh'));
</script>
<template>
  <section class="next-step-card">
    <div class="section-title"><UIcon name="i-lucide-git-merge" /><h3>{{ task.status === 'MERGED' ? 'Merged · ready to push' : 'Deliver accepted work' }}</h3></div>
    <p v-if="task.status === 'ACCEPTED'">Merge the accepted commit into the project’s default branch, or push the task branch for collaboration.</p>
    <p v-else>The accepted commit is included in the default branch. Push it when you’re ready to publish.</p>
    <p class="field-note">Accepted commit <code>{{ task.accepted_commit_sha?.slice(0, 12) }}</code>. Worktrees and review evidence are preserved.</p>
    <UAlert v-if="error" color="error" variant="subtle" :description="error" />
    <UAlert v-if="success" color="success" variant="subtle" :description="success" />
    <template v-if="details">
      <UAlert v-if="task.status === 'ACCEPTED' && details.mergeBlocker" color="warning" variant="subtle" :description="details.mergeBlocker" />
      <div class="action-row"><UButton v-if="task.status === 'ACCEPTED'" icon="i-lucide-git-merge" :disabled="busy || !!details.mergeBlocker" @click="run('merge')">Merge into {{ details.defaultBranch }}</UButton><UButton color="neutral" variant="ghost" icon="i-lucide-refresh-cw" :disabled="busy" @click="run('refresh')">Refresh delivery</UButton></div>
      <template v-if="details.remotes.length">
        <UFormField label="Git remote"><USelect v-model="remote" :items="details.remotes" :disabled="busy" class="w-full" /></UFormField>
        <p class="field-note">Push uses your Git credentials and preserves remote history. {{ task.status === 'MERGED' ? `Pushing ${details.defaultBranch} includes all its local commits through ${details.defaultHead.slice(0, 12)}.` : `Task branch: ${details.taskBranch}.` }}</p>
        <div class="action-row"><UButton icon="i-lucide-cloud-upload" color="neutral" variant="outline" :disabled="busy || !remote" @click="run('task')">Push task branch</UButton><UButton v-if="task.status === 'MERGED'" icon="i-lucide-cloud-upload" :disabled="busy || !remote" @click="run('default')">Push {{ details.defaultBranch }}</UButton></div>
      </template>
      <p v-else class="field-note">No Git remotes configured. Add a remote to this repository to enable pushing.</p>
    </template>
    <UButton v-else color="neutral" variant="ghost" :loading="busy" @click="run('refresh')">Refresh delivery</UButton>
    <p v-if="busy" role="status" class="field-note">Completing Git operation…</p>
  </section>
</template>
