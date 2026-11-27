<script setup lang="ts">
import { computed, ref } from 'vue';
import { findingClassification } from '../../../packages/contracts/src/failures';
import type { EvidenceBundle, WorkspaceDetails } from '../../../packages/contracts/src/index';
const props = defineProps<{ bundle: EvidenceBundle; status: string; details: WorkspaceDetails | null; busy: boolean }>();
const emit = defineEmits<{ decide: [action: 'accept' | 'accept_override' | 'request_changes' | 'reject', feedback: string]; diff: [file?: string] }>();
const feedback = ref('');
const acknowledge = ref(false);
const evidence = computed(() => JSON.parse(props.bundle.body_json));
const override = computed(() => evidence.value.mode === 'override');
const earlierReviews = computed(() => evidence.value.reviewHistory.filter((review: { id: string }) => review.id !== evidence.value.review?.id));
const canDecide = computed(() => props.status === 'FINAL_REVIEW' || override.value && ['BLOCKED', 'FAILED', 'CANCELLED'].includes(props.status));
const current = computed(() => props.details && !props.details.dirty && props.details.currentHead === props.bundle.commit_sha && props.details.workspaceDigest === evidence.value.workspaceDigest);
const summaries = computed(() => evidence.value.implementations.map((run: { id: string; stage: string; summary: string }) => ({ ...run, result: JSON.parse(run.summary || '{}') })));
</script>
<template>
  <section class="final-review-panel">
    <div class="section-title"><UIcon name="i-lucide-shield-check" /><h3>{{ ['ACCEPTED','MERGED'].includes(status) ? override ? 'Accepted with known failures' : 'Accepted change' : status === 'REJECTED' ? 'Rejected change' : 'Final human review' }}</h3><UBadge color="neutral" variant="subtle" size="xs">Exact commit</UBadge></div>
    <p>Review the change and its captured evidence. Acceptance records the exact commit and evidence bundle below.</p>
    <UAlert v-if="override" color="warning" variant="subtle" title="Acceptance with known failures" description="This commit has not passed the normal quality gate. Failed, missing, and blocked evidence stays recorded after acceptance." class="mb-4" />
    <p v-if="evidence.pipelineBlocker" class="field-note">{{ evidence.pipelineBlocker.failure?.label }} · {{ evidence.pipelineBlocker.message ?? evidence.pipelineBlocker.reason }}</p>
    <p v-if="evidence.configurationError">{{ evidence.configurationError }}</p>
    <article v-for="failure in evidence.failures ?? []" :key="failure.id" class="issue-section"><h3>{{ failure.label }} · {{ failure.stage }}</h3><code>{{ failure.error_code }}</code><p>{{ failure.summary }}</p><p class="field-note">{{ failure.recovery }}</p></article>
    <UCollapsible class="evidence-disclosure"><UButton color="neutral" variant="ghost" trailing-icon="i-lucide-chevron-down" class="disclosure-trigger"><span>Commit &amp; evidence</span><code>{{ bundle.commit_sha.slice(0, 10) }}</code></UButton><template #content><dl class="artifact-facts px-4"><dt>Commit</dt><dd><code>{{ bundle.commit_sha }}</code></dd><dt>Base</dt><dd><code>{{ evidence.baseSha }}</code></dd><dt>Evidence</dt><dd><code>{{ bundle.sha256_digest }}</code></dd></dl></template></UCollapsible>
    <div v-for="run in summaries" :key="run.id" class="issue-section"><h3>{{ run.stage === 'repair' ? 'Repair summary' : 'Implementation summary' }}</h3><p class="review-summary">{{ run.result.summary }}</p><h3>Known limitations</h3><ul v-if="run.result.limitations?.length" class="limitations-list"><li v-for="limitation in run.result.limitations" :key="limitation">{{ limitation }}</li></ul><p v-else class="field-note">None reported by this attempt.</p></div>
    <div class="section-title"><h3>Required checks</h3><UBadge :color="override ? 'warning' : 'success'" variant="subtle" size="xs">{{ override ? 'Captured outcomes' : `${evidence.checks.length} passed` }}</UBadge></div><p v-if="!evidence.checks.length" class="field-note">No configured check results available. Checks are not verified.</p><article v-for="check in evidence.checks" :key="check.id" class="check-card"><div class="check-card-heading"><UIcon :name="!check.status || check.status === 'passed' ? 'i-lucide-circle-check' : 'i-lucide-circle-alert'" /><strong>{{ check.name }}</strong><UBadge v-if="check.status" :color="check.status === 'passed' ? 'success' : 'warning'" variant="subtle">{{ check.status }}</UBadge><small class="check-commit">exit {{ check.exitCode ?? 'not run' }}</small></div><code class="check-command">{{ check.commitSha }}</code><UCollapsible class="evidence-disclosure"><UButton color="neutral" variant="ghost" trailing-icon="i-lucide-chevron-down" class="disclosure-trigger">Captured log</UButton><template #content><pre class="log-view">{{ check.log || 'No output captured.' }}</pre></template></UCollapsible></article>
    <UCollapsible v-if="override && (evidence.validations.length || evidence.initializations.length)" class="evidence-disclosure"><UButton color="neutral" variant="ghost" trailing-icon="i-lucide-chevron-down" class="disclosure-trigger">All captured validation &amp; setup attempts</UButton><template #content><article v-for="attempt in [...evidence.validations, ...evidence.initializations]" :key="attempt.id" class="check-card"><strong>{{ attempt.name ?? 'Worktree initialization' }} · {{ attempt.status }}</strong><p>{{ attempt.reason }}</p><pre class="log-view">{{ attempt.log_text || 'No output captured.' }}</pre></article></template></UCollapsible>
    <div v-if="evidence.review" class="evidence-block mt-6"><div class="evidence-block-header"><UIcon name="i-lucide-scan-eye" /><h3>Independent review</h3><UBadge :color="evidence.review.verdict === 'pass' && !override ? 'success' : 'warning'" variant="subtle" size="xs">{{ evidence.review.verdict }}{{ evidence.review.status ? ` · ${evidence.review.status}` : '' }}</UBadge></div><div class="evidence-block-body"><p class="review-summary">{{ evidence.review.summary }}</p><p v-if="!evidence.review.findings.length">No outstanding findings reported.</p><ul v-else class="finding-list"><li v-for="(finding, index) in evidence.review.findings" :key="index"><strong>{{ finding.severity }} · {{ findingClassification(finding) }} · {{ finding.title }}</strong><code>{{ finding.file }}</code><p>{{ finding.rationale }}</p><p>{{ finding.suggestedFix }}</p></li></ul></div></div>
    <p v-else class="field-note">Independent review not available for this commit.</p>
    <UCollapsible v-if="earlierReviews.length" class="evidence-disclosure"><UButton color="neutral" variant="ghost" trailing-icon="i-lucide-chevron-down" class="disclosure-trigger">Earlier review outcomes · {{ earlierReviews.length }}</UButton><template #content><article v-for="review in earlierReviews" :key="review.id" class="history-item"><strong>{{ review.verdict }}</strong><p>{{ review.summary }}</p><code>{{ review.commit_sha }}</code><pre>{{ JSON.stringify(JSON.parse(review.findings_json), null, 2) }}</pre><p class="field-note">Historical review; consult its commit and the current outcomes above.</p></article></template></UCollapsible>
    <div class="evidence-disclosure"><UButton color="neutral" variant="ghost" trailing-icon="i-lucide-arrow-right" class="disclosure-trigger" @click="emit('diff')">Reviewed diff · {{ evidence.changedFiles.length }} files</UButton><div class="file-list"><button v-for="file in evidence.changedFiles" :key="file" @click="emit('diff', file)"><UIcon name="i-lucide-file-code" />{{ file }}</button></div></div>
    <div v-if="canDecide" class="final-decision">
      <h3>Your decision</h3>
      <p>{{ override ? 'Accept this exact commit despite known failures. Record why you are overriding the quality gate.' : 'Accept the reviewed commit or send focused feedback for another bounded repair.' }}</p>
      <UAlert v-if="!current" color="warning" variant="subtle" description="Refresh the worktree inspection before deciding. Evidence must match the current clean commit." class="mb-4" />
      <UFormField :label="override ? 'Override reason (required)' : 'Decision feedback'" :description="override ? 'Saved with your decision, commit, and failed evidence.' : 'Required for changes or rejection. Changes must stay within the approved scope.'"><UTextarea v-model="feedback" :rows="3" class="w-full" placeholder="Add your feedback…" /></UFormField>
      <UCheckbox v-if="override" v-model="acknowledge" label="I understand this commit may be broken and accept the known failures." class="mt-4" />
      <div class="action-row">
        <UButton v-if="override" size="sm" color="warning" icon="i-lucide-shield-alert" :disabled="busy || !current || !feedback.trim() || !acknowledge" @click="emit('decide','accept_override',feedback)">Accept despite failures</UButton>
        <template v-else>
          <UButton size="sm" icon="i-lucide-check" :disabled="busy || !current" @click="emit('decide','accept',feedback)">Accept reviewed commit</UButton>
          <UButton size="sm" color="neutral" variant="outline" :disabled="busy || !current || !feedback.trim()" @click="emit('decide','request_changes',feedback)">Request changes</UButton>
          <UButton size="sm" color="error" variant="ghost" :disabled="busy || !current || !feedback.trim()" @click="emit('decide','reject',feedback)">Reject</UButton>
        </template>
      </div>
    </div>
  </section>
</template>
