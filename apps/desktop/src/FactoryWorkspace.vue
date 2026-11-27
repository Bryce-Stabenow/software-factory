<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Command, DomainEvent, RepositoryConfiguration, LocalProjectSettings, Plan, Project, ProviderHealth, Request, Snapshot, Task, WorkspaceDetails } from '../../../packages/contracts/src/index';
import { findingClassification, taskFailure } from '../../../packages/contracts/src/failures';
import { command, nativeDesktop, selectRepositoryFolder } from './api';
import ProviderUsage from './ProviderUsage.vue';
import { usageNeedsRefresh } from './provider-usage';
import ModelSelection from './ModelSelection.vue';
import ProjectExecutionSettings from './ProjectExecutionSettings.vue';
import WorkspacePanel from './WorkspacePanel.vue';
import FinalReviewPanel from './FinalReviewPanel.vue';
import DiffPanel from './DiffPanel.vue';
import DeliveryPanel from './DeliveryPanel.vue';
import OperationalSettings from './OperationalSettings.vue';
import StatusBadge from './StatusBadge.vue';
import { statusMeta, kindIcon, priorityIcon, issueId, relativeTime } from './presentation';
import { filterRequests, groupRequests, type RequestGrouping } from './request-view';
import { parseDiff, reconcileSelectedFile } from './diff-view';
import { useToast } from '@nuxt/ui/composables';

const data = ref<Snapshot | null>(null);
const page = ref('Inbox');
const connected = ref(false);
const toast = useToast();
const showCommand = ref(false), showShortcuts = ref(false), showProject = ref(false);
const detailTab = ref('overview'), settingsTab = ref('providers');
const diffSource = ref<'workspace' | 'evidence'>('workspace');
const diffFile = ref<string | null>(null);
const diffMode = ref<'inline' | 'side-by-side'>('inline');
const globalBoardView = ref('list'), projectBoardView = ref('board');
const priorityFilter = ref('all'), providerFilter = ref('all'), attentionOnly = ref(false);
const focusedRow = ref(-1);
const taskStateFilter = ref('all');
const theme = ref<'dark' | 'light'>((() => { try { return localStorage.getItem('kulumin-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } })());
watch(theme, value => { document.documentElement.classList.toggle('dark', value === 'dark'); document.documentElement.style.colorScheme = value; try { localStorage.setItem('kulumin-theme', value); } catch { /* Restricted storage does not prevent using the app. */ } }, { immediate: true });
const selectedId = ref<string | null>(null);
const query = ref('');
const issueProjectFilter = ref('');
const requestProjectFilter = ref('');
const boardView = computed({
  get: () => issueProjectFilter.value ? projectBoardView.value : globalBoardView.value,
  set: value => { if (issueProjectFilter.value) projectBoardView.value = value; else globalBoardView.value = value; },
});
const projectFilter = computed({
  get: () => page.value === 'Inbox' ? requestProjectFilter.value : issueProjectFilter.value,
  set: value => { if (page.value === 'Inbox') requestProjectFilter.value = value; else issueProjectFilter.value = value; },
});
const hideCompleted = ref(true);
const requestGrouping = ref<RequestGrouping>('status');
const showCreate = ref(false);
const editingRequest = ref<Request | null>(null);
const requestFilter = ref('open');
const busy = ref(false);
const error = ref('');
const feedback = ref('');
const workspaceDetails = ref<WorkspaceDetails | null>(null);
const workspaceError = ref('');
const selectedWorkspace = computed(() => data.value?.workspaces.find(workspace => workspace.task_id === selectedId.value));
const selectedChecks = computed(() => data.value?.validations.filter(check => check.task_id === selectedId.value) ?? []);
const selectedEvidence = computed(() => data.value?.evidence.filter(bundle => bundle.task_id === selectedId.value).at(-1));
const selectedReviews = computed(() => data.value?.reviews.filter(review => review.task_id === selectedId.value) ?? []);
const evidenceDiff = computed(() => { try { return selectedEvidence.value ? JSON.parse(selectedEvidence.value.body_json) as { diff?: string; changedFiles?: string[]; baseSha?: string } : null; } catch { return null; } });
const diffChangedFiles = computed(() => diffSource.value === 'evidence' ? evidenceDiff.value?.changedFiles ?? [] : workspaceDetails.value?.changedFiles ?? []);
const diffText = computed(() => diffSource.value === 'evidence' ? evidenceDiff.value?.diff ?? '' : workspaceDetails.value?.diff ?? '');
const diffSections = computed(() => parseDiff(diffText.value, diffChangedFiles.value));
const selectedProject = computed(() => data.value?.projects.find(project => project.id === selected.value?.project_id));
const hasBuildRun = computed(() => data.value?.runs.some(run => run.task_id === selectedId.value && ['implement', 'validate', 'review', 'repair'].includes(run.stage)) ?? false);
const executionEnabled = computed(() => !!selectedProject.value && JSON.parse(selectedProject.value.config_json).executionEnabled === true);
const plannerChoice = ref<'inherit' | 'codex' | 'fake'>('inherit');
const planningModel = ref<string | null | undefined>(undefined), implementationModel = ref<string | null | undefined>(undefined), reviewModel = ref<string | null | undefined>(undefined);
const retryModel = ref<string | null>(null);
const startOverrides = () => ({ provider: plannerChoice.value === 'inherit' ? undefined : plannerChoice.value, planningModel: planningModel.value, implementationModel: implementationModel.value, reviewModel: reviewModel.value });
function resetOverrides() { plannerChoice.value = 'inherit'; planningModel.value = undefined; implementationModel.value = undefined; reviewModel.value = undefined; }
const questionAnswers = ref<Record<string, string>>({});
const providerName = (task: Task) => JSON.parse(task.provider_policy_json).provider === 'codex' ? 'Codex' : 'Fake agent';
const codexHealth = computed(() => data.value?.providers.find(provider => provider.id === 'codex'));
const providerLoading = ref(false), providerRefreshError = ref('');
async function refreshProvider() {
  if (providerLoading.value) return;
  providerLoading.value = true; providerRefreshError.value = '';
  try {
    const health = await command<ProviderHealth>({ type: 'provider.health', provider: 'codex' });
    if (data.value) data.value.providers = [...data.value.providers.filter(provider => provider.id !== 'codex'), health];
  } catch {
    // Hide any previously cached allowance if the bridge itself failed.
    providerRefreshError.value = 'Usage refresh failed. Check the service connection and try again.';
  } finally { providerLoading.value = false; }
}
watch([page, settingsTab, () => !!data.value], () => {
  if (page.value === 'Settings' && settingsTab.value === 'providers' && data.value && usageNeedsRefresh(codexHealth.value?.usage)) void refreshProvider();
});
const acceptedOverride = computed(() => {
  if (!['ACCEPTED', 'MERGED'].includes(selected.value?.status ?? '')) return;
  const decision = data.value?.approvals.filter(approval => approval.task_id === selectedId.value && ['accept', 'accept_override'].includes(approval.action)).at(-1);
  return decision?.action === 'accept_override' ? decision : undefined;
});
const selectedFailure = computed(() => selected.value ? taskFailure(selected.value, data.value?.runs ?? [], selectedChecks.value, data.value?.events ?? []) : null);
const canOverride = computed(() => !!selectedWorkspace.value && !!selected.value?.approved_plan_revision_id && ['BLOCKED', 'FAILED', 'CANCELLED'].includes(selected.value?.status ?? ''));
const workerActive = computed(() => !!currentRun.value && ['queued', 'starting', 'running', 'waiting_permission', 'stopping'].includes(currentRun.value.status));
const currentRun = computed(() => data.value?.runs.filter(run => run.task_id === selectedId.value).at(-1));
const openQuestions = computed(() => data.value?.questions.filter(question => question.task_id === selectedId.value && question.plan_revision_id === selected.value?.current_plan_revision_id && question.status === 'open') ?? []);
const form = ref({ projectId: '', title: '', body: '', kind: 'feature' as Request['type'], priority: 'normal', criteria: '' });
const requestDefaults = computed(() => JSON.parse(data.value?.projects.find(project => project.id === form.value.projectId)?.config_json ?? '{}'));
const requestPlanner = computed(() => plannerChoice.value === 'inherit' ? requestDefaults.value.provider : plannerChoice.value);
const taskPlanner = computed(() => plannerChoice.value === 'inherit' ? taskDefaults.value.provider : plannerChoice.value);
const taskDefaults = computed(() => JSON.parse(selectedProject.value?.config_json ?? '{}'));
watch(() => form.value.projectId, resetOverrides);
watch(showCreate, resetOverrides);
watch(selectedId, () => { resetOverrides(); retryModel.value = JSON.parse(selected.value?.provider_policy_json ?? '{}').planningModel ?? null; });
const projectForm = ref({ name: '', path: '' });
const pickingFolder = ref(false);
const pickerError = ref('');
let projectDialogSession = 0;
watch(showProject, () => { projectDialogSession++; pickerError.value = ''; }, { flush: 'sync' });
async function chooseRepositoryFolder() {
  if (!nativeDesktop || !showProject.value || pickingFolder.value || busy.value) return;
  const session = projectDialogSession;
  pickingFolder.value = true;
  pickerError.value = '';
  try {
    const path = await selectRepositoryFolder();
    if (showProject.value && session === projectDialogSession && path !== null) projectForm.value.path = path;
  } catch (cause) {
    if (showProject.value && session === projectDialogSession) pickerError.value = String(cause instanceof Error ? cause.message : cause);
  } finally {
    pickingFolder.value = false;
  }
}
const setupProjectId = ref<string | null>(null);
const setupOnboarding = ref(false);
const setupProject = computed(() => data.value?.projects.find(project => project.id === setupProjectId.value));
const projectSetupOpen = computed({ get: () => !!setupProjectId.value, set: value => { if (!value) setupProjectId.value = null; } });
const canStartRequest = computed(() => !editingRequest.value || editingRequest.value.status !== 'archived' && (!taskFor(editingRequest.value.id) || taskFor(editingRequest.value.id)?.status === 'INBOX'));
const statusLabel = (status: string) => status.toLowerCase().split('_').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
const projectName = (id: string) => data.value?.projects.find(project => project.id === id)?.name ?? 'Unknown project';
const matches = (item: { id: string; title: string; project_id: string }) => `${item.title} ${item.id} ${issueId(item.id)} REQ-${item.id.slice(0,5)}`.toLowerCase().includes(query.value.toLowerCase()) && (!projectFilter.value || projectFilter.value === item.project_id);
const filteredRequests = computed(() => filterRequests(data.value?.requests ?? [], taskFor, {
  hideCompleted: hideCompleted.value, archive: requestFilter.value, query: query.value,
  projectId: requestProjectFilter.value, priority: priorityFilter.value,
  provider: providerFilter.value, attentionOnly: attentionOnly.value,
}));
const requestGroups = computed(() => {
  let offset = 0;
  return groupRequests(filteredRequests.value, taskFor, requestGrouping.value, projectName).map(group => {
    const indexed = { ...group, offset };
    offset += group.requests.length;
    return indexed;
  });
});
const requests = computed(() => requestGroups.value.flatMap(group => group.requests));
const filterCount = computed(() => Number(!!projectFilter.value) + Number(priorityFilter.value !== 'all') + Number(providerFilter.value !== 'all') + (page.value === 'Inbox' ? Number(hideCompleted.value) : Number(taskStateFilter.value !== 'all')));
const requestsHidden = computed(() => !!data.value?.requests.length && !requests.value.length);
function clearFilters() {
  projectFilter.value = ''; priorityFilter.value = 'all'; providerFilter.value = 'all';
  taskStateFilter.value = 'all'; attentionOnly.value = false; query.value = '';
  if (page.value === 'Inbox') { hideCompleted.value = false; requestFilter.value = 'all'; }
}
function navigateWorkspace(destination: string) {
  if (destination === 'Board') issueProjectFilter.value = '';
  page.value = destination;
  if (destination !== 'Inbox') { attentionOnly.value = false; taskStateFilter.value = 'all'; }
}
function openProject(project: Project) {
  issueProjectFilter.value = project.id; taskStateFilter.value = 'all';
  attentionOnly.value = false; boardView.value = 'board'; page.value = 'Board';
}
const tasks = computed(() => data.value?.tasks.filter(task => matches(task) && (taskStateFilter.value === 'all' || taskStateFilter.value === 'accepted' && ['ACCEPTED','MERGED'].includes(task.status) || taskStateFilter.value === 'active' && data.value?.runs.some(run => run.task_id === task.id && ['queued','starting','running','waiting_permission','stopping'].includes(run.status))) && (priorityFilter.value === 'all' || taskRequest(task)?.priority === priorityFilter.value) && (providerFilter.value === 'all' || JSON.parse(task.provider_policy_json).provider === providerFilter.value) && (!attentionOnly.value || ['PLAN_REVIEW','FINAL_REVIEW','PLANNING_BLOCKED','BLOCKED','FAILED'].includes(task.status))) ?? []);
const attention = computed(() => data.value?.tasks.filter(task => ['PLAN_REVIEW', 'FINAL_REVIEW', 'PLANNING_BLOCKED', 'BLOCKED', 'FAILED'].includes(task.status)) ?? []);
const selected = computed(() => data.value?.tasks.find(task => task.id === selectedId.value));
watch(() => selected.value?.provider_policy_json, policy => { retryModel.value = JSON.parse(policy ?? '{}').planningModel ?? null; });
function taskRequest(task: Task): Request | undefined {
  const version = JSON.parse(task.provider_policy_json).requestVersion ?? 1;
  const revision = data.value?.requestRevisions.find(revision => revision.request_id === task.request_id && revision.version === version);
  return revision ? JSON.parse(revision.body_json) : undefined;
}
const selectedRequest = computed(() => selected.value ? taskRequest(selected.value) : undefined);
const revisions = computed(() => data.value?.plans.filter(plan => plan.task_id === selectedId.value) ?? []);
const revision = computed(() => revisions.value.find(plan => plan.id === selected.value?.current_plan_revision_id));
const plan = computed<Plan | null>(() => revision.value ? JSON.parse(revision.value.body_json) : null);
const decisions = computed(() => data.value?.approvals.filter(approval => approval.task_id === selectedId.value) ?? []);
const taskEvents = computed(() => data.value?.events.filter(event => event.task_id === selectedId.value).slice().reverse() ?? []);
const columns = [
  { name: 'Inbox', statuses: ['INBOX'] }, { name: 'Planning', statuses: ['PLANNING', 'PLANNING_BLOCKED'] },
  { name: 'Plan review', statuses: ['PLAN_REVIEW'] }, { name: 'Build & verify', statuses: ['QUEUED_FOR_BUILD', 'BUILDING', 'VALIDATING', 'REPAIRING'] },
  { name: 'Code review', statuses: ['CODE_REVIEW'] }, { name: 'Final review', statuses: ['FINAL_REVIEW'] },
  { name: 'Done', statuses: ['ACCEPTED', 'MERGED'] }, { name: 'Needs attention', statuses: ['FAILED', 'BLOCKED', 'REJECTED', 'CANCELLED'] },
];
const taskFor = (requestId: string) => data.value?.tasks.find(task => task.request_id === requestId);
const formatDate = (date: string) => new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
async function refresh() {
  try { data.value = await command<Snapshot>({ type: 'snapshot' }); connected.value = true; } catch (cause) { connected.value = false; throw cause; }
  if (!form.value.projectId) form.value.projectId = data.value.projects[0]?.id ?? '';
}
async function perform<T>(action: () => Promise<T>): Promise<T | undefined> {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try { const result = await action(); await refresh(); return result; }
  catch (cause) { error.value = String(cause instanceof Error ? cause.message : cause); await refresh().catch(() => {}); }
  finally { busy.value = false; }
}
const act = (payload: Command) => perform(() => command<unknown>(payload));
function openNewRequest() {
  error.value = ''; editingRequest.value = null; form.value = { projectId: projectFilter.value || data.value?.projects[0]?.id || '', title: '', body: '', kind: 'feature', priority: 'normal', criteria: '' }; showCreate.value = true;
}
function editRequest(request: Request) {
  error.value = ''; editingRequest.value = request; form.value = { projectId: request.project_id, title: request.title, body: request.body, kind: request.type, priority: request.priority, criteria: JSON.parse(request.acceptance_criteria_json).join('\n') }; showCreate.value = true;
}
async function duplicateRequest(request: Request) {
  const result = await act({ type: 'request.duplicate', requestId: request.id, expectedVersion: request.version }) as { id: string } | undefined;
  const revised = data.value?.requests.find(item => item.id === result?.id); if (revised) { requestFilter.value = 'open'; editRequest(revised); }
}
async function createRequest(startTask = false) {
  if (!form.value.projectId || !form.value.title.trim() || !form.value.body.trim() || editingRequest.value?.status === 'archived' || startTask && !canStartRequest.value) return;
  await perform(async () => {
    const saved = await command<{ id: string }>({ ...(editingRequest.value ? { type: 'request.update' as const, requestId: editingRequest.value.id, expectedVersion: editingRequest.value.version } : { type: 'request.create' as const }), projectId: form.value.projectId, title: form.value.title, body: form.value.body, kind: form.value.kind as 'feature' | 'bug' | 'refactor' | 'chore', priority: form.value.priority as 'high' | 'normal' | 'low', acceptanceCriteria: form.value.criteria.split('\n').map(line => line.trim()).filter(Boolean) });
    // Retain the saved identity if starting fails, so a retry cannot create duplicates.
    await refresh();
    editingRequest.value = data.value?.requests.find(request => request.id === saved.id) ?? null;
    if (!editingRequest.value) throw new Error('The request was saved. Refresh the request list before starting it.');
    if (startTask) {
      const task = await command<Task>({ type: 'request.startTask', requestId: saved.id, expectedVersion: editingRequest.value.version, ...startOverrides() });
      openTask(task);
    } else toast.add({ title: 'Request saved', description: 'Start it from the request menu whenever you’re ready.', icon: 'i-lucide-bookmark' });
    showCreate.value = false;
  });
}
async function startSavedRequest(request: Request) {
  const task = await act({ type: 'request.startTask', requestId: request.id, expectedVersion: request.version }) as Task | undefined;
  if (task) openTask(task);
}
async function review(action: 'approve' | 'request_changes' | 'reject') {
  if (!selected.value || !revision.value) return;
  const result = await act({ type: 'task.reviewPlan', taskId: selected.value.id, expectedVersion: selected.value.version, revisionId: revision.value.id, digest: revision.value.sha256_digest, action, feedback: feedback.value });
  if (result) { feedback.value = ''; if (action !== 'request_changes') detailTab.value = 'overview'; toast.add({ title: action === 'approve' ? 'Plan approved' : action === 'request_changes' ? 'Plan changes requested' : 'Plan rejected', icon: 'i-lucide-check' }); }
}
async function inspectWorkspace() {
  const taskId = selectedId.value;
  if (!taskId || !selectedWorkspace.value) { workspaceDetails.value = null; return; }
  workspaceError.value = '';
  try {
    const details = await command<WorkspaceDetails>({ type: 'workspace.inspect', taskId });
    if (selectedId.value !== taskId) return;
    workspaceDetails.value = details;
    if (['CODE_REVIEW','FINAL_REVIEW','ACCEPTED'].includes(selected.value?.status ?? '') && (details.currentHead !== details.head_sha || details.dirty)) await refresh();
  } catch (cause) { if (selectedId.value === taskId) { workspaceDetails.value = null; workspaceError.value = String(cause instanceof Error ? cause.message : cause); } }
}
async function resumeWork(stage: 'implement' | 'validate' | 'review' | 'initialize') {
  if (!selected.value || !workspaceDetails.value) return;
  await act({ type: 'task.resume', taskId: selected.value.id, expectedVersion: selected.value.version, stage, expectedHead: workspaceDetails.value.currentHead, expectedWorkspaceDigest: workspaceDetails.value.workspaceDigest });
}
async function prepareOverride() {
  const taskId = selected.value?.id;
  await inspectWorkspace();
  if (!selected.value || selected.value.id !== taskId || !workspaceDetails.value) return;
  await act({ type: 'task.prepareOverride', taskId: selected.value.id, expectedVersion: selected.value.version, expectedHead: workspaceDetails.value.currentHead, expectedWorkspaceDigest: workspaceDetails.value.workspaceDigest });
  if (selected.value?.id === taskId) detailTab.value = 'review';
}
async function reviewFinal(action: 'accept' | 'accept_override' | 'request_changes' | 'reject', feedback: string) {
  if (!selected.value || !selectedEvidence.value) return;
  const result = await act({ type: 'task.reviewFinal', taskId: selected.value.id, expectedVersion: selected.value.version, bundleId: selectedEvidence.value.id, digest: selectedEvidence.value.sha256_digest, expectedHead: selectedEvidence.value.commit_sha, action, feedback });
  if (result && ['accept', 'accept_override'].includes(action)) detailTab.value = 'overview';
}
async function copyText(text: string) { try { await navigator.clipboard.writeText(text); toast.add({ title: 'Copied to clipboard', icon: 'i-lucide-check', color: 'success' }); } catch { error.value = 'Clipboard access is unavailable. Select and copy the branch text from the task worktree section.'; } }
watch(selectedId, () => { feedback.value = ''; questionAnswers.value = {}; detailTab.value = 'overview'; diffSource.value = 'workspace'; diffFile.value = null; workspaceDetails.value = null; workspaceError.value = ''; });
watch(diffSections, sections => { diffFile.value = reconcileSelectedFile(sections, diffFile.value); });
function openDiff(source: 'workspace' | 'evidence', file?: string) {
  diffSource.value = source;
  diffFile.value = reconcileSelectedFile(diffSections.value, file ?? diffFile.value);
  detailTab.value = 'diff';
}
watch([selectedId, () => selected.value?.version, () => selectedWorkspace.value?.head_sha, () => selectedWorkspace.value?.cleanup_status], () => { workspaceDetails.value = null; void inspectWorkspace(); });
function eventLabel(event: DomainEvent) { return event.type.replaceAll('.', ' · ').replaceAll('_', ' '); }
let timer: ReturnType<typeof setInterval>;
onMounted(async () => {
  window.addEventListener('keydown', handleKeydown);
  try { await refresh(); } catch (cause) { error.value = String(cause); }
  timer = setInterval(async () => {
    if (!data.value || busy.value || providerLoading.value) return;
    try { const events = await command<DomainEvent[]>({ type: 'events.list', afterSequence: data.value.cursor }); connected.value = true; if (events.length) await refresh(); }
    catch { connected.value = false; }
  }, 2000);
});
onUnmounted(() => { projectDialogSession++; clearInterval(timer); window.removeEventListener('keydown', handleKeydown); });

watch([page, requestGrouping, () => requests.value.map(request => request.id).join(',')], () => { focusedRow.value = -1; });
watch(detailTab, async () => { await nextTick(); document.querySelector('.issue-detail-scroll')?.scrollTo({ top: 0 }); });
const taskOpen = computed({ get: () => !!selectedId.value, set: value => { if (!value) selectedId.value = null; } });
const navItems = [
  { page: 'Inbox', label: 'Requests', icon: 'i-lucide-inbox' },
  { page: 'Board', label: 'Issues', icon: 'i-lucide-circle-dot' },
  { page: 'Dashboard', label: 'Overview', icon: 'i-lucide-layout-dashboard' },
  { page: 'Projects', label: 'Projects', icon: 'i-lucide-folder-kanban' },
];
const pageTitle = computed(() => navItems.find(item => item.page === page.value)?.label ?? page.value);
const pageIcon = computed(() => navItems.find(item => item.page === page.value)?.icon ?? 'i-lucide-settings-2');
const detailTabs = [{ label: 'Overview', value: 'overview' }, { label: 'Plan', value: 'plan' }, { label: 'Changes & checks', value: 'changes' }, { label: 'Diff', value: 'diff' }, { label: 'Review', value: 'review' }, { label: 'Activity', value: 'activity' }];
const settingTabs = [{ label: 'Providers', value: 'providers' }, { label: 'Operations & recovery', value: 'operations' }, { label: 'Appearance', value: 'appearance' }];
const projectItems = computed(() => [{ label: 'All projects', value: 'all' }, ...(data.value?.projects.map(project => ({ label: project.name, value: project.id })) ?? [])]);
const selectedProjectFilter = computed({ get: () => projectFilter.value || 'all', set: value => { projectFilter.value = value === 'all' ? '' : value; } });
const formProjects = computed(() => data.value?.projects.map(project => ({ label: project.name, value: project.id })) ?? []);
const running = computed(() => data.value?.runs.filter(run => ['queued','starting','running','waiting_permission','stopping'].includes(run.status)) ?? []);
const completed = computed(() => data.value?.tasks.filter(task => ['ACCEPTED','MERGED'].includes(task.status)) ?? []);
const commandGroups = computed(() => [
  { id: 'actions', label: 'Workspace', items: [
    { label: 'Create request', icon: 'i-lucide-square-pen', kbds: ['C'], onSelect: () => { showCommand.value = false; openNewRequest(); } },
    ...navItems.map(item => ({ label: `Go to ${item.label.toLowerCase()}`, icon: item.icon, onSelect: () => { navigateWorkspace(item.page); showCommand.value = false; } })),
    { label: 'Settings', icon: 'i-lucide-settings-2', onSelect: () => { page.value = 'Settings'; showCommand.value = false; } },
    { label: `Switch to ${theme.value === 'dark' ? 'light' : 'dark'} theme`, icon: 'i-lucide-sun-moon', onSelect: () => { theme.value = theme.value === 'dark' ? 'light' : 'dark'; showCommand.value = false; } },
  ] },
  { id: 'tasks', label: 'Issues', items: data.value?.tasks.map(task => ({ label: task.title, suffix: issueId(task.id), icon: statusMeta(task.status).icon, onSelect: () => { openTask(task); showCommand.value = false; } })) ?? [] },
  { id: 'requests', label: 'Requests without an issue', items: data.value?.requests.filter(request => !taskFor(request.id)).map(request => ({ label: request.title, suffix: request.status, icon: kindIcon(request.type), onSelect: () => { editRequest(request); showCommand.value = false; } })) ?? [] },
]);
const workspaceMenu = computed(() => [[
  { label: 'Workspace settings', icon: 'i-lucide-settings-2', onSelect: () => { page.value = 'Settings'; } },
  { label: 'Keyboard shortcuts', icon: 'i-lucide-keyboard', onSelect: () => { showShortcuts.value = true; } },
]]);
const requestMenu = (request: Request) => [[
  ...(request.status !== 'archived' && (!taskFor(request.id) || taskFor(request.id)?.status === 'INBOX') ? [{ label: 'Start task with Codex', icon: 'i-lucide-play', onSelect: () => { void startSavedRequest(request); } }] : []),
  ...(request.status !== 'archived' ? [{ label: 'Edit request', icon: 'i-lucide-pencil', onSelect: () => editRequest(request) }] : []),
  ...(taskFor(request.id) ? [{ label: 'Create revised request', icon: 'i-lucide-copy-plus', onSelect: () => { void duplicateRequest(request); } }] : []),
  { label: request.status === 'archived' ? 'Restore request' : 'Archive request', icon: request.status === 'archived' ? 'i-lucide-archive-restore' : 'i-lucide-archive', onSelect: () => { void act({ type: 'request.archive', requestId: request.id, expectedVersion: request.version, archived: request.status !== 'archived' }); } },
]];
function openTask(task: Task) { selectedId.value = task.id; detailTab.value = task.status === 'PLAN_REVIEW' ? 'plan' : task.status === 'FINAL_REVIEW' ? 'review' : 'overview'; }
function openRequest(request: Request) { const task = taskFor(request.id); if (task) openTask(task); else editRequest(request); }
function configureProject(project: Project) { error.value = ''; setupOnboarding.value = false; setupProjectId.value = project.id; }
async function saveProjectSettings(settings: { configuration: RepositoryConfiguration; local: LocalProjectSettings; expectedDigest: string | null }) {
  if (!setupProject.value) return;
  const project = setupProject.value;
  const result = await act({ type: 'project.configuration.save', projectId: project.id, expectedVersion: project.version, ...settings });
  if (result) { setupProjectId.value = null; toast.add({ title: 'Project settings saved', description: 'Saved .kulumin.yml. Commit it on the default branch before creating a new task worktree.', icon: 'i-lucide-check' }); }
}
async function registerProject() {
  if (!showProject.value || busy.value || pickingFolder.value || !projectForm.value.name.trim() || !projectForm.value.path.trim()) return;
  pickerError.value = '';
  const result = await act({ type: 'project.add', path: projectForm.value.path, name: projectForm.value.name }) as { id: string } | undefined;
  if (result) { showProject.value = false; projectForm.value = { name: '', path: '' }; page.value = 'Projects'; setupOnboarding.value = true; setupProjectId.value = result.id; }
}
function handleKeydown(event: KeyboardEvent) {
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === 'k') { event.preventDefault(); showCommand.value = !showCommand.value; return; }
  if (modifier && event.key.toLowerCase() === 'n') { event.preventDefault(); openNewRequest(); return; }
  if (modifier || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, [contenteditable="true"], [role="combobox"]') || taskOpen.value || showCreate.value || showCommand.value || showProject.value || projectSetupOpen.value || showShortcuts.value) return;
  if (event.key.toLowerCase() === 'c' && !modifier && !event.altKey) { event.preventDefault(); openNewRequest(); }
  if (event.key === '?') { event.preventDefault(); showShortcuts.value = true; }
  if (['j','k'].includes(event.key) && ['Inbox','Board'].includes(page.value)) { const total = page.value === 'Inbox' ? requests.value.length : tasks.value.length; if (!total) return; event.preventDefault(); focusedRow.value = Math.min(total - 1, Math.max(0, focusedRow.value + (event.key === 'j' ? 1 : -1))); document.querySelector<HTMLButtonElement>(`[data-issue-index="${focusedRow.value}"]`)?.focus(); }
}

</script>

<template>
  <div class="factory-shell">
    <aside class="workspace-sidebar" aria-label="Workspace navigation">
      <div class="workspace-switcher"><UDropdownMenu :items="workspaceMenu" :content="{ align: 'start' }"><button class="workspace-name"><span class="workspace-logo"><img src="/kulumin-mark.svg" alt="Kulumin ship" width="26" height="26" /></span><span>Kulumin<small>Personal workspace</small></span><UIcon name="i-lucide-chevrons-up-down" class="workspace-chevron" /></button></UDropdownMenu></div>
      <div class="sidebar-quick-actions"><button class="quick-search" @click="showCommand = true"><UIcon name="i-lucide-search" /><span>Search anything</span><UKbd value="meta" /><UKbd>K</UKbd></button><UTooltip text="New request" :kbds="['C']"><UButton class="new-request-button" icon="i-lucide-square-pen" color="neutral" variant="outline" aria-label="New request" @click="openNewRequest" /></UTooltip></div>
      <nav class="primary-navigation"><button v-for="item in navItems" :key="item.page" :class="{ active: page === item.page }" @click="navigateWorkspace(item.page)"><UIcon :name="item.icon" /><span>{{ item.label }}</span><span v-if="item.page === 'Inbox'" class="nav-number">{{ data?.requests.filter(request => request.status === 'open').length ?? 0 }}</span><span v-if="item.page === 'Board' && running.length" class="nav-live">{{ running.length }}</span></button></nav>
      <div class="sidebar-section-heading"><span>Your projects</span><UTooltip text="Connect repository"><UButton icon="i-lucide-plus" size="xs" color="neutral" variant="ghost" aria-label="Connect repository" @click="error = ''; showProject = true" /></UTooltip></div>
      <nav class="project-navigation"><button v-for="(project, index) in data?.projects" :key="project.id" :class="{ active: projectFilter === project.id && ['Inbox','Board'].includes(page) }" @click="openProject(project)"><span class="project-monogram" :class="`project-color-${index % 4}`">{{ project.name.slice(0,1).toUpperCase() }}</span><span>{{ project.name }}</span><span class="nav-number">{{ data?.tasks.filter(task => task.project_id === project.id).length }}</span></button><button v-if="!data?.projects.length" class="sidebar-empty" @click="error = ''; showProject = true"><UIcon name="i-lucide-folder-plus" /><span>Connect your first repo</span></button></nav>
      <div class="sidebar-footer"><button class="sidebar-settings" :class="{ active: page === 'Settings' }" @click="page = 'Settings'"><UIcon name="i-lucide-settings-2" /><span>Settings</span><span class="connection-dot" :class="{ online: connected }" :title="connected ? 'Service connected' : 'Service disconnected'" /></button></div>
    </aside>

    <main class="workspace-main">
      <header class="workspace-topbar"><div class="page-breadcrumb"><UIcon :name="pageIcon" /><h1>{{ pageTitle }}</h1><span v-if="page === 'Inbox' || page === 'Board'" class="header-count">{{ page === 'Inbox' ? requests.length : tasks.length }}</span><UIcon name="i-lucide-chevron-right" class="breadcrumb-chevron" /><span>{{ projectFilter && ['Inbox','Board'].includes(page) ? projectName(projectFilter) : 'Workspace' }}</span></div><div class="header-actions"><UButton v-if="running.length" icon="i-lucide-square" color="error" variant="soft" size="xs" :disabled="busy" @click="act({ type: 'agents.stopAll', reason: 'Emergency stop requested by the local user.' })">Stop all</UButton><UTooltip text="Command menu" :kbds="['meta','K']"><UButton icon="i-lucide-command" color="neutral" variant="ghost" aria-label="Open command menu" @click="showCommand = true" /></UTooltip><UButton v-if="page === 'Projects'" icon="i-lucide-plus" size="sm" @click="error = ''; showProject = true">Connect repository</UButton><UTooltip v-else-if="page !== 'Settings'" text="New request" :kbds="['C']"><UButton class="new-request-button" icon="i-lucide-square-pen" color="neutral" variant="outline" aria-label="New request" @click="openNewRequest" /></UTooltip></div></header>
      <div v-if="error && !showCreate && !showProject && !projectSetupOpen && !taskOpen" class="global-error"><UAlert color="error" variant="soft" icon="i-lucide-circle-alert" :description="error" :close="{ onClick: () => { error = ''; } }" /></div>
      <div v-if="!connected && data" class="connection-banner"><UIcon name="i-lucide-wifi-off" /><span>The service connection was interrupted. Your last saved state is still visible.</span><UButton size="xs" color="neutral" variant="outline" @click="act({ type: 'snapshot' })">Reconnect</UButton></div>

      <template v-if="page === 'Inbox' || page === 'Board'">
        <div class="view-toolbar"><div class="view-tabs"><button :class="{ active: !attentionOnly && taskStateFilter === 'all' }" @click="attentionOnly = false; taskStateFilter = 'all'">{{ page === 'Inbox' ? 'All requests' : 'All issues' }}</button><button :class="{ active: attentionOnly }" @click="attentionOnly = true; taskStateFilter = 'all'"><UIcon name="i-lucide-circle-dot" />Needs attention<span v-if="attention.length">{{ attention.length }}</span></button></div><div class="view-controls"><UInput v-model="query" icon="i-lucide-search" placeholder="Search title or ID…" aria-label="Filter by title or ID" size="sm" class="list-search" /><USelect v-if="page === 'Inbox'" v-model="requestFilter" :items="[{ label: 'Active', value: 'open' }, { label: 'Archived', value: 'archived' }, { label: 'All', value: 'all' }]" aria-label="Request archive filter" size="sm" class="archive-filter" /><UPopover :content="{ align: 'end' }"><UButton icon="i-lucide-list-filter" color="neutral" variant="outline" size="sm">Filter<UBadge v-if="filterCount" size="xs" color="primary">{{ filterCount }}</UBadge></UButton><template #content><div class="filter-popover"><h3>Filter {{ page === 'Inbox' ? 'requests' : 'issues' }}</h3><UCheckbox v-if="page === 'Inbox'" v-model="hideCompleted" label="Hide completed" /><UFormField label="Project"><USelect v-model="selectedProjectFilter" :items="projectItems" class="w-full" /></UFormField><UFormField v-if="page === 'Board'" label="Status"><USelect v-model="taskStateFilter" :items="[{ label: 'Any status', value: 'all' }, { label: 'In progress', value: 'active' }, { label: 'Accepted', value: 'accepted' }]" class="w-full" /></UFormField><UFormField label="Priority"><USelect v-model="priorityFilter" :items="[{ label: 'Any priority', value: 'all' }, { label: 'High', value: 'high' }, { label: 'Normal', value: 'normal' }, { label: 'Low', value: 'low' }]" class="w-full" /></UFormField><UFormField label="Provider"><USelect v-model="providerFilter" :items="[{ label: 'Any provider', value: 'all' }, { label: 'Codex', value: 'codex' }, { label: 'Simulation', value: 'fake' }]" class="w-full" /></UFormField><UButton color="neutral" variant="ghost" size="xs" @click="clearFilters">Clear filters</UButton></div></template></UPopover><label v-if="page === 'Inbox'" class="request-group-control"><span>Group by</span><USelect v-model="requestGrouping" :items="[{ label: 'Request status', value: 'status' }, { label: 'Project', value: 'project' }]" aria-label="Group by" size="sm" /></label><UTabs v-if="page === 'Board'" v-model="boardView" :items="[{ icon: 'i-lucide-list', value: 'list', label: 'List' }, { icon: 'i-lucide-columns-3', value: 'board', label: 'Board' }]" :content="false" color="neutral" size="xs" class="layout-toggle" /></div></div>
        <div class="workspace-view" :class="{ 'workspace-view-board': page === 'Board' && boardView === 'board' }">
          <template v-if="page === 'Inbox'">
            <div class="list-context"><div><UIcon name="i-lucide-inbox" /><h2>{{ attentionOnly ? 'Awaiting your decision' : requestFilter === 'archived' ? 'Archived requests' : 'Requests' }}</h2><span>{{ requests.length }}</span></div></div>
            <div v-if="requests.length" class="issue-table" aria-label="Requests"><div class="issue-table-heading"><span>Request</span><span>Project</span><span>Priority</span><span>Status</span><span></span></div><template v-for="group in requestGroups" :key="group.key"><div class="request-group-heading"><h3>{{ group.label }}</h3><span>{{ group.requests.length }}</span></div><div v-for="(request, index) in group.requests" :key="request.id" class="issue-row" @click="openRequest(request)"><button class="issue-open" :data-issue-index="group.offset + index" @focus="focusedRow = group.offset + index" :aria-label="`Open request: ${request.title}`"><UIcon :name="kindIcon(request.type)" class="issue-kind" :class="{ 'bug-icon': request.type === 'bug' }" /><span class="issue-identifier">REQ-{{ request.id.slice(0,5).toUpperCase() }}</span><span class="issue-title">{{ request.title }}</span><UIcon v-if="request.status === 'archived'" name="i-lucide-archive" class="size-3.5 text-muted" /></button><span class="row-project"><span class="project-indicator" />{{ projectName(request.project_id) }}</span><span class="row-priority" :class="request.priority"><UIcon :name="priorityIcon(request.priority)" />{{ request.priority }}</span><StatusBadge v-if="taskFor(request.id)" :status="taskFor(request.id)!.status" /><span v-else class="not-started"><UIcon name="i-lucide-circle-dashed" />{{ request.status === 'archived' ? 'Archived' : 'Saved for later' }}</span><div class="row-menu" @click.stop><UDropdownMenu :items="requestMenu(request)"><UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" :disabled="busy" :aria-label="`Actions for ${request.title}`" /></UDropdownMenu></div></div></template></div>
            <div v-else class="view-empty"><span class="empty-icon"><UIcon :name="requestsHidden ? 'i-lucide-search-x' : 'i-lucide-inbox'" /></span><h2>{{ requestsHidden ? 'No matching requests' : 'Start with an idea' }}</h2><p>{{ requestsHidden ? 'Your filters hide all requests. Clear filters to include completed and archived work.' : 'Capture a feature, bug, or improvement. You’ll review the plan before any code changes.' }}</p><UButton v-if="requestsHidden" color="neutral" variant="outline" @click="clearFilters">Clear filters</UButton><UButton v-else icon="i-lucide-plus" @click="openNewRequest">Create request</UButton></div>
          </template>
          <template v-else>
            <div class="list-context"><div><UIcon name="i-lucide-circle-dot" /><h2>{{ attentionOnly ? 'Needs attention' : taskStateFilter === 'active' ? 'In progress' : taskStateFilter === 'accepted' ? 'Accepted issues' : 'All issues' }}</h2><span>{{ tasks.length }}</span></div><span class="list-context-help">Plan. Build. Validate. Review.</span></div>
            <div v-if="boardView === 'list' && tasks.length" class="issue-table"><div class="issue-table-heading"><span>Issue</span><span>Project</span><span>Provider</span><span>Status</span><span></span></div><div v-for="(task, index) in tasks" :key="task.id" class="issue-row" @click="openTask(task)"><button class="issue-open" :data-issue-index="index" :aria-label="`Open issue: ${task.title}`"><UIcon :name="statusMeta(task.status).icon" class="issue-kind" :class="`tone-${statusMeta(task.status).color}`" /><span class="issue-identifier">{{ issueId(task.id) }}</span><span class="issue-title">{{ task.title }}</span></button><span class="row-project"><span class="project-indicator" />{{ projectName(task.project_id) }}</span><span class="row-provider"><UIcon :name="providerName(task) === 'Codex' ? 'i-lucide-sparkles' : 'i-lucide-flask-conical'" />{{ providerName(task) === 'Codex' ? 'Codex' : 'Simulation' }}</span><StatusBadge :status="task.status" /><UIcon name="i-lucide-chevron-right" class="row-chevron" /></div></div>
            <div v-else-if="boardView === 'board'" class="kanban-board"><section v-for="column in columns" :key="column.name" class="kanban-column"><div class="kanban-heading"><span :class="`tone-${statusMeta(column.statuses[0]).color}`" class="column-indicator" /><h3>{{ column.name }}</h3><span>{{ tasks.filter(task => column.statuses.includes(task.status)).length }}</span></div><button v-for="task in tasks.filter(task => column.statuses.includes(task.status))" :key="task.id" class="kanban-card" :data-issue-index="tasks.indexOf(task)" @click="openTask(task)"><div><span>{{ issueId(task.id) }}</span><UIcon :name="statusMeta(task.status).icon" :class="`tone-${statusMeta(task.status).color}`" /></div><strong>{{ task.title }}</strong><p>{{ projectName(task.project_id) }}</p><footer><StatusBadge :status="task.status" /><span>{{ relativeTime(task.updated_at) }}</span></footer></button><div v-if="!tasks.some(task => column.statuses.includes(task.status))" class="kanban-empty">No issues</div></section></div>
            <div v-else class="view-empty"><span class="empty-icon"><UIcon name="i-lucide-circle-dashed" /></span><h2>No issues yet</h2><p>Start a task from a saved request to begin planning. Every change begins with your approval.</p><UButton color="neutral" variant="outline" @click="navigateWorkspace('Inbox')">Go to requests</UButton></div>
          </template>
        </div>
        <footer class="view-footer"><span><UKbd>J</UKbd><UKbd>K</UKbd> to navigate <span class="footer-divider">·</span><UKbd>↵</UKbd> to open</span></footer>
      </template>

      <div v-else-if="page === 'Dashboard'" class="overview-page">
        <div class="page-intro"><div><span class="section-eyebrow">WORKSPACE OVERVIEW</span><h2>A clear path from idea to done.</h2><p>Your decisions, active work, and recent progress in one place.</p></div><span class="overview-date">{{ new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) }}</span></div>
        <div class="overview-metrics"><button @click="attentionOnly = true; taskStateFilter = 'all'; projectFilter = ''; priorityFilter = 'all'; providerFilter = 'all'; query = ''; page = 'Board'"><span><UIcon name="i-lucide-circle-dot" />Needs attention</span><strong>{{ attention.length }}</strong><small>Waiting for your decision</small></button><button @click="attentionOnly = false; taskStateFilter = 'active'; projectFilter = ''; priorityFilter = 'all'; providerFilter = 'all'; query = ''; page = 'Board'"><span><UIcon name="i-lucide-loader-circle" />In progress</span><strong>{{ running.length }}</strong><small>Active or queued runs</small></button><button @click="attentionOnly = false; taskStateFilter = 'accepted'; projectFilter = ''; priorityFilter = 'all'; providerFilter = 'all'; query = ''; page = 'Board'"><span><UIcon name="i-lucide-circle-check" />Accepted</span><strong>{{ completed.length }}</strong><small>Human-reviewed changes</small></button></div>
        <section class="overview-section"><div class="section-title"><h3>Needs your attention</h3><UBadge color="neutral" variant="subtle" size="sm">{{ attention.length }}</UBadge></div><div class="surface"><button v-for="task in attention" :key="task.id" class="attention-issue" @click="openTask(task)"><UIcon :name="statusMeta(task.status).icon" :class="`tone-${statusMeta(task.status).color}`" /><span class="issue-identifier">{{ issueId(task.id) }}</span><span class="issue-title">{{ task.title }}</span><StatusBadge :status="task.status" /><UIcon name="i-lucide-arrow-up-right" class="size-4 text-muted" /></button><div v-if="!attention.length" class="compact-empty"><UIcon name="i-lucide-check-check" /><div><strong>You’re all caught up</strong><p>Issues that need your approval or help will appear here.</p></div></div></div></section>
        <div class="overview-grid"><section class="overview-section"><div class="section-title"><h3>Workers</h3><UBadge color="neutral" variant="subtle" size="sm">{{ running.length }}</UBadge></div><div class="surface"><button v-for="run in running" :key="run.id" class="worker-row" @click="data?.tasks.find(task => task.id === run.task_id) && openTask(data.tasks.find(task => task.id === run.task_id)!)"><span class="worker-avatar"><UIcon name="i-lucide-sparkles" /></span><span><strong>{{ data?.tasks.find(task => task.id === run.task_id)?.title }}</strong><small>{{ run.stage }} · {{ run.model ?? 'Selecting model' }}</small></span><StatusBadge :status="run.status" /></button><div v-if="!running.length" class="compact-empty"><UIcon name="i-lucide-moon" /><div><strong>No workers running</strong><p>Approved work will appear here as it starts.</p></div></div></div></section><section class="overview-section"><div class="section-title"><h3>Recent activity</h3><UIcon name="i-lucide-activity" class="size-4 text-muted" /></div><div class="surface activity-feed"><div v-for="event in data?.events.slice(-6).reverse()" :key="event.sequence"><span class="activity-dot" /><span>{{ eventLabel(event) }}</span><time>{{ relativeTime(event.created_at) }}</time></div><div v-if="!data?.events.length" class="compact-empty">Activity appears as requests move through the factory.</div></div></section></div>
        <div class="workflow-footnote"><UIcon name="i-lucide-shield-check" /><span>You approve the plan. You accept the finished change. The factory handles the work between.</span></div>
      </div>

      <div v-else-if="page === 'Projects'" class="projects-page"><div class="page-intro"><div><h2>Connected repositories</h2><p>A local home for each project, with execution boundaries you control.</p></div></div><div v-if="!data?.projects.length" class="view-empty"><span class="empty-icon"><UIcon name="i-lucide-folder-git-2" /></span><h2>Bring your first project</h2><p>Connect an existing Git repository to start capturing requests.</p><UButton icon="i-lucide-plus" @click="error = ''; showProject = true">Connect repository</UButton></div><article v-for="(project, index) in data?.projects" :key="project.id" class="project-surface"><div class="project-card-heading"><span class="project-monogram project-monogram-large" :class="`project-color-${index % 4}`">{{ project.name.slice(0,1).toUpperCase() }}</span><div><h3>{{ project.name }}</h3><p>{{ project.repo_path }}</p></div><UBadge :color="JSON.parse(project.config_json).executionEnabled ? 'success' : 'neutral'" variant="subtle"><UIcon :name="JSON.parse(project.config_json).executionEnabled ? 'i-lucide-shield-check' : 'i-lucide-lock-keyhole'" class="size-3" />{{ JSON.parse(project.config_json).executionEnabled ? 'Execution enabled' : 'Plan only' }}</UBadge></div><div class="project-card-meta"><span><UIcon name="i-lucide-git-branch" />{{ project.default_branch }}</span><span><UIcon name="i-lucide-circle-dot" />{{ data?.tasks.filter(task => task.project_id === project.id).length }} issues</span><span><UIcon name="i-lucide-list-checks" />{{ JSON.parse(project.config_json).validationCommands?.length ?? 0 }} checks configured</span><UButton color="neutral" variant="ghost" size="xs" trailing-icon="i-lucide-arrow-up-right" @click="openProject(project)">View issues</UButton></div><div class="project-settings-action"><span class="field-note">{{ JSON.parse(project.config_json).executionEnabled ? 'Review checks and execution permissions.' : 'Ready for planning. Configure checks to prepare for implementation.' }}</span><UButton color="neutral" variant="outline" size="sm" icon="i-lucide-settings-2" @click="configureProject(project)">Project settings</UButton></div></article></div>

      <div v-else-if="page === 'Settings'" class="settings-page"><div class="page-intro"><div><h2>Workspace settings</h2><p>Providers, appearance, and the health of your local factory.</p></div></div><UTabs v-model="settingsTab" :items="settingTabs" :content="false" variant="link" color="neutral" class="settings-tabs" /><div v-if="settingsTab === 'providers'" class="settings-content"><section class="settings-section"><div class="section-title"><h3>Agent providers</h3><span class="section-caption">Your sign-in stays with the provider CLI</span></div><div class="surface provider-surface"><div class="provider-line"><span class="provider-logo"><UIcon name="i-lucide-sparkles" /></span><div><h4>Codex <UBadge :color="codexHealth?.authenticated ? 'success' : 'neutral'" size="xs" variant="subtle">{{ codexHealth?.authenticated ? 'Connected' : 'Not verified' }}</UBadge></h4><p>{{ codexHealth?.message }}</p><code v-if="codexHealth?.version">{{ codexHealth.version }}</code></div><UButton color="neutral" variant="outline" :loading="providerLoading" @click="refreshProvider()">Check connection</UButton></div><ProviderUsage :usage="codexHealth?.usage" :loading="providerLoading" :refresh-error="providerRefreshError" @refresh="refreshProvider" /><div class="provider-line"><span class="provider-logo muted-provider"><UIcon name="i-lucide-flask-conical" /></span><div><h4>Simulation <UBadge size="xs" color="neutral" variant="subtle">Development</UBadge></h4><p>Deterministic plans for testing the workflow. Simulated plans cannot authorize execution.</p></div></div><div class="provider-line"><span class="provider-logo muted-provider"><UIcon name="i-lucide-bot" /></span><div><h4>Claude Code</h4><p>Not enabled in this release.</p></div><UBadge color="neutral" variant="subtle">Unavailable</UBadge></div></div></section><UAlert color="neutral" variant="subtle" icon="i-lucide-shield-check" title="Two human checkpoints" description="Implementation requires approval of the exact plan. Completion requires acceptance of the exact reviewed commit. Repositories stay read-only until you enable trusted execution in Projects." /></div><OperationalSettings v-else-if="settingsTab === 'operations'" @reload="refresh" /><div v-else class="settings-content"><section class="settings-section"><div class="section-title"><h3>Appearance</h3><span class="section-caption">Saved on this device</span></div><div class="appearance-options"><button :class="{ selected: theme === 'dark' }" @click="theme = 'dark'"><span class="appearance-preview dark-preview"><i /><i /><i /></span><span>Dark<UIcon v-if="theme === 'dark'" name="i-lucide-circle-check" /></span></button><button :class="{ selected: theme === 'light' }" @click="theme = 'light'"><span class="appearance-preview light-preview"><i /><i /><i /></span><span>Light<UIcon v-if="theme === 'light'" name="i-lucide-circle-check" /></span></button></div></section><section class="surface keyboard-setting"><UIcon name="i-lucide-keyboard" /><div><h3>Made for your keyboard</h3><p>Move between issues and keep your hands on the keys.</p></div><UButton color="neutral" variant="outline" @click="showShortcuts = true">View shortcuts</UButton></section></div></div>
    </main>
  </div>

  <UModal v-model:open="showCreate" :title="editingRequest ? 'Edit request' : 'New request'" description="Capture a clear outcome for your project." :ui="{ content: 'request-dialog', header: 'dialog-header', body: 'dialog-body', footer: 'dialog-footer' }">
    <template #body><form id="request-form" class="request-form" @submit.prevent="createRequest(false)" @keydown.meta.enter.prevent="createRequest(false)" @keydown.ctrl.enter.prevent="createRequest(false)"><UAlert v-if="error" color="error" variant="soft" :description="error" icon="i-lucide-circle-alert" /><UAlert v-if="editingRequest?.status === 'archived'" color="neutral" variant="subtle" description="This request is archived. Restore it from the request actions menu to edit it." /><UAlert v-if="editingRequest && taskFor(editingRequest.id)" color="warning" variant="soft" icon="i-lucide-lock-keyhole" description="The existing issue keeps its original request and approval. Create a revised request to start a separate issue for new scope." /><UFormField label="Title" required><UInput v-model="form.title" required maxlength="200" placeholder="What would you like to build?" size="lg" class="w-full" autofocus /></UFormField><UFormField label="Description" required><UTextarea v-model="form.body" required :rows="4" placeholder="Describe the problem and the outcome you want…" class="w-full" autoresize /></UFormField><div class="form-columns"><UFormField label="Project" required><USelect v-model="form.projectId" :items="formProjects" placeholder="Select project" class="w-full" /></UFormField><UFormField label="Type"><USelect v-model="form.kind" :items="['feature','bug','refactor','chore']" class="w-full capitalize" /></UFormField><UFormField label="Priority"><USelect v-model="form.priority" :items="['low','normal','high']" class="w-full capitalize" /></UFormField></div><UFormField label="Acceptance criteria" hint="One per line"><UTextarea v-model="form.criteria" :rows="3" placeholder="What must be true when this is done?" class="w-full" autoresize /></UFormField><section v-if="canStartRequest" class="request-start-options"><div class="form-columns two"><UFormField label="Planner"><USelect v-model="plannerChoice" :items="[{ label: 'Use project default', value: 'inherit' }, { label: 'Codex', value: 'codex' }, { label: 'Simulation', value: 'fake' }]" class="w-full" /></UFormField><ModelSelection v-model="planningModel" label="Planning model" inherit :project-default="requestDefaults.planningModel" :health="codexHealth" /><ModelSelection v-model="implementationModel" label="Implementation & repair model" inherit :project-default="requestDefaults.implementationModel" :health="codexHealth" /><ModelSelection v-model="reviewModel" label="Independent review model" inherit :project-default="requestDefaults.reviewModel" :health="codexHealth" /><p class="field-note">Project planner: {{ requestDefaults.provider === 'fake' ? 'Simulation' : 'Codex' }}</p><UButton color="neutral" variant="ghost" :disabled="busy" @click="refreshProvider()">Refresh models</UButton></div><p class="field-note">Save for later to keep this as a request. Start task saves it and immediately queues {{ requestPlanner === 'codex' ? 'read-only Codex planning' : 'a simulated plan' }}. Code changes always wait for your approval.</p></section><p v-if="!data?.projects.length" class="field-note">Connect a repository in Projects before creating a request.</p></form></template>
    <template #footer><span class="dialog-keyboard-hint"><UKbd value="meta" /><UKbd>↵</UKbd> to save for later</span><UButton color="neutral" variant="ghost" :disabled="busy" @click="showCreate = false">Cancel</UButton><UButton type="submit" form="request-form" color="neutral" variant="outline" :loading="busy" :disabled="!form.projectId || !form.title.trim() || !form.body.trim() || editingRequest?.status === 'archived'">{{ editingRequest && !canStartRequest ? 'Save changes' : 'Save for later' }}</UButton><UButton v-if="canStartRequest" icon="i-lucide-play" :loading="busy" :disabled="!form.projectId || !form.title.trim() || !form.body.trim()" @click="createRequest(true)">Start task</UButton></template>
  </UModal>

  <UModal v-model:open="showProject" title="Connect a repository" description="Choose an existing local Git repository." :ui="{ content: 'project-dialog', header: 'dialog-header', body: 'dialog-body', footer: 'dialog-footer' }"><template #body><form id="project-form" class="request-form" @submit.prevent="registerProject"><UAlert v-if="error" color="error" variant="soft" :description="error" /><UFormField label="Project name" required><UInput v-model="projectForm.name" required maxlength="120" placeholder="My project" class="w-full" /></UFormField><UFormField label="Repository path" required><div class="flex items-center gap-2"><UInput v-model="projectForm.path" required :disabled="pickingFolder" placeholder="/Users/you/projects/my-project" icon="i-lucide-folder-git-2" class="min-w-0 flex-1" /><UButton v-if="nativeDesktop" type="button" color="neutral" variant="outline" icon="i-lucide-folder-open" :loading="pickingFolder" :disabled="busy || pickingFolder" @click="chooseRepositoryFolder">Choose folder</UButton></div></UFormField><p v-if="!nativeDesktop" class="field-note">Enter the repository’s full local path. Choose folder is available in the desktop app.</p><UAlert v-if="pickerError" color="error" variant="soft" :description="pickerError" role="alert" /><p class="field-note">The main checkout stays untouched. Execution starts disabled; enable it explicitly for trusted repositories.</p></form></template><template #footer><UButton color="neutral" variant="ghost" @click="showProject = false">Cancel</UButton><UButton type="submit" form="project-form" :loading="busy" :disabled="busy || pickingFolder || !projectForm.name.trim() || !projectForm.path.trim()">Connect repository</UButton></template></UModal>

  <UModal v-model:open="projectSetupOpen" :title="setupOnboarding ? 'Finish project setup' : 'Project settings'" :description="setupProject ? `Checks and permissions for ${setupProject.name}. You can also save it for planning only.` : 'Configure your project.'" :ui="{ content: 'project-settings-dialog', header: 'dialog-header', body: 'dialog-body' }"><template #body><UAlert v-if="error" color="error" variant="subtle" :description="error" class="mb-4" /><ProjectExecutionSettings v-if="setupProject" :key="setupProject.id" :project="setupProject" :busy="busy" :health="codexHealth" @refresh="refreshProvider()" @save="saveProjectSettings" /><div class="setup-later-row"><UButton color="neutral" variant="ghost" :disabled="busy" @click="setupProjectId = null">Set up later</UButton></div></template></UModal>

  <UModal v-model:open="showCommand" title="Search workspace" description="Find issues, requests, and actions." :ui="{ content: 'command-dialog' }"><template #content><UCommandPalette :groups="commandGroups" placeholder="Search issues, requests, and actions…" :close="{ onClick: () => { showCommand = false; } }" class="command-palette" /></template></UModal>
  <UModal v-model:open="showShortcuts" title="Keyboard shortcuts" description="A faster way to move through your workspace." :ui="{ content: 'shortcuts-dialog', header: 'dialog-header', body: 'dialog-body' }"><template #body><div class="shortcut-row"><span>Command menu</span><span><UKbd value="meta" /><UKbd>K</UKbd></span></div><div class="shortcut-row"><span>New request</span><UKbd>C</UKbd></div><div class="shortcut-row"><span>New request, anywhere</span><span><UKbd value="meta" /><UKbd>N</UKbd></span></div><div class="shortcut-row"><span>Navigate issue list</span><span><UKbd>J</UKbd><UKbd>K</UKbd></span></div><div class="shortcut-row"><span>Open focused issue</span><UKbd>↵</UKbd></div><div class="shortcut-row"><span>Close dialog</span><UKbd>Esc</UKbd></div><div class="shortcut-row"><span>Show shortcuts</span><UKbd>?</UKbd></div></template></UModal>

  <UModal v-model:open="taskOpen" :title="selected?.title ?? 'Issue details'" description="Task details, approved scope, and evidence." :ui="{ content: 'task-dialog' }">
    <template #content><template v-if="selected"><header class="issue-detail-header"><div><span class="project-indicator" /><span>{{ projectName(selected.project_id) }}</span><UIcon name="i-lucide-chevron-right" /><span class="mono">{{ issueId(selected.id) }}</span><StatusBadge :status="selected.status" /></div><div class="detail-header-actions"><UTooltip text="Copy issue ID"><UButton icon="i-lucide-copy" color="neutral" variant="ghost" size="xs" aria-label="Copy issue ID" @click="copyText(issueId(selected.id))" /></UTooltip><UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" aria-label="Close issue" @click="selectedId = null" /></div></header>
      <div class="issue-detail-layout"><div class="issue-detail-main"><div class="issue-title-area"><span class="section-eyebrow">{{ providerName(selected) === 'Codex' ? 'CODEX' : 'SIMULATION' }} · {{ issueId(selected.id) }}</span><h2>{{ selected.title }}</h2><UTabs v-model="detailTab" :items="detailTabs" :content="false" variant="link" color="neutral" size="sm" class="issue-detail-tabs" /></div><div class="issue-detail-scroll">
        <UAlert v-if="error" color="error" variant="soft" icon="i-lucide-circle-alert" :description="error" class="mb-5" /><UAlert v-if="selected.reason" color="warning" variant="soft" icon="i-lucide-circle-alert" :title="selectedFailure?.label ?? selected.reason" :description="`${selected.reason} ${selectedFailure?.recovery ?? selected.recovery_action ?? ''}`" class="mb-5" />
        <UAlert v-if="acceptedOverride" color="warning" variant="soft" title="Accepted with known failures" :description="acceptedOverride.feedback" class="mb-5" /><section v-show="detailTab === 'overview'" class="issue-tab-panel"><UButton v-if="canOverride" color="warning" variant="outline" class="mb-5" @click="detailTab = 'review'">Review failures &amp; override</UButton>
          <div class="issue-section"><h3>Description</h3><p class="request-description">{{ selectedRequest?.body }}</p><small class="scope-note"><UIcon name="i-lucide-lock-keyhole" />Captured request version {{ selectedRequest?.version ?? 'unknown' }}. Inbox edits do not change this issue.</small></div>
          <section v-if="selectedRequest && JSON.parse(selectedRequest.acceptance_criteria_json).length" class="issue-section"><h3>Acceptance criteria</h3><ul class="criteria-list"><li v-for="criterion in JSON.parse(selectedRequest.acceptance_criteria_json)"><UIcon name="i-lucide-circle" />{{ criterion }}</li></ul></section>
          <div v-if="selected.status === 'INBOX'" class="next-step-card"><div class="next-step-heading"><span class="next-step-icon"><UIcon name="i-lucide-sparkles" /></span><div><h3>Start with a plan</h3><p>A read-only proposal comes before any code changes.</p></div></div><div class="form-columns two"><UFormField label="Planner"><USelect v-model="plannerChoice" :items="[{ label: 'Use project default', value: 'inherit' }, { label: 'Codex', value: 'codex' }, { label: 'Simulation', value: 'fake' }]" class="w-full" /></UFormField><ModelSelection v-model="planningModel" label="Planning model" inherit :project-default="taskDefaults.planningModel" :health="codexHealth" /><ModelSelection v-model="implementationModel" label="Implementation & repair model" inherit :project-default="taskDefaults.implementationModel" :health="codexHealth" /><ModelSelection v-model="reviewModel" label="Independent review model" inherit :project-default="taskDefaults.reviewModel" :health="codexHealth" /><p class="field-note">Project planner: {{ taskDefaults.provider === 'fake' ? 'Simulation' : 'Codex' }}</p><UButton color="neutral" variant="ghost" :disabled="busy" @click="refreshProvider()">Refresh models</UButton></div><p class="field-note">{{ taskPlanner === 'codex' ? 'Uses your CLI sign-in and a bounded repository snapshot. The planner cannot edit files or execute commands.' : 'Simulation uses a fixed plan without a model call. It cannot authorize real execution.' }}</p><div class="action-row"><UButton icon="i-lucide-sparkles" :loading="busy" @click="act({ type: 'task.assign', taskId: selected.id, expectedVersion: selected.version, ...startOverrides() })">{{ taskPlanner === 'codex' ? 'Start planning' : 'Generate simulated plan' }}</UButton></div></div>
          <div v-if="selected.status === 'PLANNING'" class="next-step-card"><div class="next-step-heading"><span class="next-step-icon"><UIcon name="i-lucide-loader-circle" class="animate-spin" /></span><div><h3>{{ currentRun?.status === 'queued' ? 'Planning queued' : 'Reading your repository' }}</h3><p>Repository reads and progress are recorded in Activity.</p></div></div><UButton color="neutral" variant="outline" trailing-icon="i-lucide-arrow-right" @click="detailTab = 'activity'">View progress</UButton></div>
          <div v-if="['PLAN_REVIEW','FINAL_REVIEW'].includes(selected.status)" class="next-step-card"><div class="next-step-heading"><span class="next-step-icon attention-icon"><UIcon name="i-lucide-circle-dot" /></span><div><h3>{{ selected.status === 'PLAN_REVIEW' ? 'Your plan is ready' : 'Ready for your final review' }}</h3><p>{{ selected.status === 'PLAN_REVIEW' ? 'Review the scope, steps, and testing strategy before authorizing implementation.' : 'Review the exact commit, checks, and independent findings before accepting.' }}</p></div></div><UButton trailing-icon="i-lucide-arrow-right" @click="detailTab = selected.status === 'PLAN_REVIEW' ? 'plan' : 'review'">{{ selected.status === 'PLAN_REVIEW' ? 'Review plan' : 'Review change' }}</UButton></div>
          <form v-if="selected.status === 'PLANNING_BLOCKED'" class="next-step-card request-form" @submit.prevent="act({ type: 'task.answerQuestions', taskId: selected.id, expectedVersion: selected.version, answers: openQuestions.map(question => ({ questionId: question.id, answer: questionAnswers[question.id] ?? '' })) })"><h3>A little more context</h3><p>Answer these questions to generate a new plan revision.</p><UFormField v-for="question in openQuestions" :key="question.id" :label="question.prompt" required><UTextarea v-model="questionAnswers[question.id]" :rows="2" required class="w-full" /></UFormField><UButton type="submit" :loading="busy" :disabled="openQuestions.some(question => !questionAnswers[question.id]?.trim())">Answer &amp; replan</UButton></form>
          <div v-if="['FAILED','BLOCKED'].includes(selected.status) && !hasBuildRun" class="next-step-card request-form"><h3>Planning needs your attention</h3><p>{{ currentRun?.summary }}</p><ModelSelection v-if="providerName(selected) === 'Codex'" :model-value="retryModel" @update:model-value="retryModel = $event ?? null" label="Planning model for retry" :health="codexHealth" /><div class="action-row"><UButton :loading="busy" @click="act({ type: 'task.retry', taskId: selected.id, expectedVersion: selected.version, planningModel: retryModel })">Retry planning</UButton><UButton color="neutral" variant="ghost" :disabled="busy" @click="refreshProvider()">Refresh models</UButton></div></div>
          <div v-if="selected.status === 'QUEUED_FOR_BUILD'" class="next-step-card"><h3>Approved and queued</h3><p>{{ executionEnabled ? 'A worker will use a dedicated worktree and branch.' : 'Enable implementation and configure checks for this trusted repository in Projects.' }}</p><UAlert v-if="providerName(selected) !== 'Codex'" color="neutral" variant="subtle" icon="i-lucide-flask-conical" description="Simulated plans cannot authorize real execution. Create a new task with a real Codex plan." /><UButton v-else :disabled="busy || !executionEnabled || currentRun?.status === 'queued'" :loading="currentRun?.status === 'queued'" @click="act({ type: 'task.run', taskId: selected.id, expectedVersion: selected.version })">Start approved implementation</UButton></div>
          <div v-if="['BUILDING','VALIDATING','REPAIRING','CODE_REVIEW'].includes(selected.status)" class="next-step-card"><div class="next-step-heading"><span class="next-step-icon"><UIcon name="i-lucide-loader-circle" class="animate-spin" /></span><div><h3>{{ selected.status === 'BUILDING' ? 'Implementing the approved plan' : selected.status === 'REPAIRING' ? 'Repairing within approved scope' : selected.status === 'VALIDATING' ? 'Checking the current commit' : 'Independent read-only review' }}</h3><p>Changes stay in the task worktree. Progress and evidence are captured as the work runs.</p></div></div><div class="action-row"><UButton color="neutral" variant="outline" @click="detailTab = 'activity'">View activity</UButton><UButton v-if="selected.status === 'CODE_REVIEW' && (!currentRun || !['queued','starting','running','stopping'].includes(currentRun.status))" :disabled="busy" @click="act({ type: 'task.startReview', taskId: selected.id, expectedVersion: selected.version })">Revalidate &amp; review</UButton></div></div>
          <div v-if="hasBuildRun && ['BLOCKED','FAILED','CANCELLED'].includes(selected.status)" class="next-step-card"><h3>Recover preserved work</h3><p>The branch, edits, commits, and logs are preserved. Inspect the worktree before resuming.</p><UButton v-if="selectedWorkspace && selectedWorkspace.cleanup_status !== 'creating'" trailing-icon="i-lucide-arrow-right" color="neutral" variant="outline" @click="detailTab = 'changes'">Inspect worktree &amp; recover</UButton><UButton v-else color="neutral" variant="outline" :disabled="busy" @click="act({ type: 'task.run', taskId: selected.id, expectedVersion: selected.version })">Retry build setup</UButton></div>
          <DeliveryPanel v-if="['ACCEPTED','MERGED'].includes(selected.status)" :key="`${selected.id}-${selected.version}`" :task="selected" @changed="refresh" />
        </section>
        <section v-show="detailTab === 'plan'" class="issue-tab-panel"><template v-if="plan && revision"><div class="plan-revision-heading"><UBadge color="neutral" variant="subtle">Revision {{ revision.revision_number }}</UBadge><UBadge color="neutral" variant="outline">{{ providerName(selected) === 'Codex' ? 'Codex proposal' : 'Simulated proposal' }}</UBadge><span v-if="selected.approved_plan_revision_id === revision.id" class="approved-label"><UIcon name="i-lucide-check" />Approved</span></div><p class="plan-summary">{{ plan.summary }}</p><section v-for="[label, values] in [['Steps', plan.steps], ['Acceptance criteria', plan.acceptanceCriteria], ['Test strategy', plan.testStrategy], ['Affected areas', plan.affectedAreas], ['Assumptions', plan.assumptions], ['Risks', plan.risks]] as [string, string[]][]" :key="label" class="issue-section"><h3>{{ label }}</h3><ol v-if="label === 'Steps'" class="plan-steps"><li v-for="(value, index) in values" :key="index"><span>{{ index + 1 }}</span><p>{{ value }}</p></li></ol><ul v-else class="text-list"><li v-for="value in values" :key="value">{{ value }}</li><li v-if="!values.length" class="text-muted">None reported.</li></ul></section><UCollapsible class="evidence-disclosure"><UButton icon="i-lucide-fingerprint" color="neutral" variant="ghost" trailing-icon="i-lucide-chevron-down" class="disclosure-trigger">Exact plan digest</UButton><template #content><code class="artifact-digest">{{ revision.sha256_digest }}</code></template></UCollapsible><section v-if="selected.status === 'PLAN_REVIEW'" class="approval-card"><div class="section-title"><UIcon name="i-lucide-shield-check" /><h3>Your authorization</h3></div><p>Approval authorizes this exact revision. {{ providerName(selected) !== 'Codex' ? 'This is a simulation; approval cannot authorize real execution.' : executionEnabled ? 'Implementation starts in an isolated worktree.' : 'Implementation stays queued until execution is enabled.' }}</p><UFormField label="Feedback" hint="Required for changes or rejection"><UTextarea v-model="feedback" :rows="3" placeholder="What needs to change?" class="w-full" /></UFormField><div class="action-row"><UButton icon="i-lucide-check" :loading="busy" @click="review('approve')">Approve plan</UButton><UButton color="neutral" variant="outline" :disabled="busy || !feedback.trim()" @click="review('request_changes')">Request changes</UButton><UButton color="error" variant="ghost" :disabled="busy || !feedback.trim()" @click="review('reject')">Reject</UButton></div></section><UCollapsible v-if="revisions.length > 1" class="evidence-disclosure"><UButton color="neutral" variant="ghost" trailing-icon="i-lucide-chevron-down" class="disclosure-trigger">Plan history · {{ revisions.length }} revisions</UButton><template #content><article v-for="item in revisions" :key="item.id" class="history-item"><strong>Revision {{ item.revision_number }}</strong><pre>{{ item.body_markdown }}</pre><code>{{ item.sha256_digest }}</code></article></template></UCollapsible></template><div v-else class="tab-empty"><UIcon name="i-lucide-file-text" /><h3>No plan yet</h3><p>Start planning from Overview. A proposal appears here before any code changes.</p><UButton color="neutral" variant="outline" @click="detailTab = 'overview'">Go to overview</UButton></div></section>
        <section v-show="detailTab === 'changes'" class="issue-tab-panel"><WorkspacePanel v-if="selectedWorkspace" :workspace="selectedWorkspace" :details="workspaceDetails" :initializations="data?.initializations.filter(run => run.task_id === selected?.id) ?? []" :checks="selectedChecks" :status="selected.status" :busy="busy || !!currentRun && ['queued','starting','running','stopping'].includes(currentRun.status)" :error="workspaceError" @inspect="inspectWorkspace" @open="act({ type: 'workspace.open', taskId: selected.id })" @copy="copyText" @resume="resumeWork" @diff="openDiff('workspace', $event)" /><div v-else class="tab-empty"><UIcon name="i-lucide-git-branch" /><h3>No worktree yet</h3><p>The factory creates an isolated branch after you approve a real plan and enable execution.</p></div></section>
        <section v-show="detailTab === 'diff'" class="issue-tab-panel"><DiffPanel :diff="diffText" :changed-files="diffChangedFiles" :source="diffSource" :selected-file="diffFile" :mode="diffMode" :truncated="diffSource === 'workspace' && !!workspaceDetails?.truncated" :loading="diffSource === 'workspace' && !!selectedWorkspace && !workspaceDetails && !workspaceError" :error="diffSource === 'workspace' ? workspaceError : ''" :base="diffSource === 'evidence' ? evidenceDiff?.baseSha : workspaceDetails?.reviewBaseSha ?? selectedWorkspace?.base_sha" :commit="diffSource === 'evidence' ? selectedEvidence?.commit_sha : workspaceDetails?.currentHead" @select="diffFile = $event" @mode="diffMode = $event" /></section>
        <section v-show="detailTab === 'review'" class="issue-tab-panel"><section v-if="canOverride" class="next-step-card mb-5"><h3>Review failures &amp; override</h3><p>Capture the current commit, failed checks, missing evidence, and review findings. You can accept the result with a recorded reason even when it is broken.</p><UButton color="warning" variant="outline" :disabled="busy || workerActive || !!workspaceDetails?.dirty" @click="prepareOverride">Prepare override review</UButton><p v-if="workspaceDetails?.dirty" class="field-note">Commit the preserved edits before accepting an exact commit.</p><p v-if="workerActive" class="field-note">Wait for the worker to stop before preparing override review.</p></section><FinalReviewPanel v-if="selectedEvidence && (['FINAL_REVIEW','ACCEPTED','MERGED','REJECTED'].includes(selected.status) || canOverride && JSON.parse(selectedEvidence.body_json).mode === 'override')" :key="selectedEvidence.id" :bundle="selectedEvidence" :status="selected.status" :details="workspaceDetails" :busy="busy || workerActive" @decide="reviewFinal" @diff="openDiff('evidence', $event)" /><section v-if="selectedReviews.length" class="issue-section"><h3>Independent review history</h3><article v-for="item in selectedReviews.slice().reverse()" :key="item.id" class="review-history-card"><div><StatusBadge :status="item.verdict === 'pass' ? 'passed' : item.verdict === 'blocked' ? 'BLOCKED' : 'PLAN_REVIEW'" /><UBadge color="neutral" variant="subtle" size="xs">{{ item.status }}</UBadge><code>{{ item.commit_sha.slice(0,12) }}</code></div><p>{{ item.summary }}</p><ul v-for="finding in JSON.parse(item.findings_json)" class="finding-list"><li><strong>{{ finding.severity }} · {{ findingClassification(finding) }} · {{ finding.title }}</strong><code>{{ finding.file }}{{ finding.line ? ':' + finding.line : '' }}</code><p>{{ finding.rationale }}</p><p>{{ finding.suggestedFix }}</p></li></ul></article></section><div v-if="!selectedReviews.length" class="tab-empty"><UIcon name="i-lucide-scan-eye" /><h3>Review comes after validation</h3><p>A separate read-only session reviews the exact commit, checks, and approved scope.</p></div></section>
        <section v-show="detailTab === 'activity'" class="issue-tab-panel"><section v-if="decisions.length" class="issue-section"><h3>Decision history</h3><article v-for="decision in decisions.slice().reverse()" :key="decision.id" class="decision-item"><span class="decision-icon"><UIcon :name="decision.action === 'accept' || decision.action === 'approve' ? 'i-lucide-check' : 'i-lucide-message-square'" /></span><div><strong>{{ decision.gate === 'plan' ? 'Plan' : 'Final review' }} · {{ statusLabel(decision.action) }}</strong><time>{{ new Date(decision.decided_at).toLocaleString() }}</time><p>{{ decision.feedback || (decision.gate === 'final' ? 'Accepted the exact reviewed commit and evidence.' : 'Approved the exact plan revision.') }}</p></div></article></section><h3>Run activity</h3><div class="issue-timeline"><div v-for="event in taskEvents" :key="event.sequence"><span class="timeline-dot" /><div><strong>{{ eventLabel(event) }}</strong><p v-if="JSON.parse(event.payload_json).message">{{ JSON.parse(event.payload_json).message }}</p><p v-if="event.type.startsWith('delivery.') && JSON.parse(event.payload_json).commit"><span>{{ JSON.parse(event.payload_json).branch }}<template v-if="JSON.parse(event.payload_json).remote"> → {{ JSON.parse(event.payload_json).remote }}</template></span> · <code>{{ JSON.parse(event.payload_json).commit.slice(0,12) }}</code></p></div><time>{{ formatDate(event.created_at) }}</time></div><p v-if="!taskEvents.length" class="field-note">Run progress will appear here.</p></div><UCollapsible v-if="currentRun?.provider_session_ref" class="evidence-disclosure"><UButton color="neutral" variant="ghost" trailing-icon="i-lucide-chevron-down" class="disclosure-trigger">Provider session details</UButton><template #content><dl class="artifact-facts"><dt>Model</dt><dd>{{ currentRun.model }}</dd><dt>Session</dt><dd>{{ currentRun.provider_session_ref }}</dd><dt>Turn</dt><dd>{{ currentRun.turn_ref ?? 'Starting' }}</dd></dl></template></UCollapsible></section>
      </div></div><aside class="issue-properties"><h3>Properties</h3><dl><dt>Status</dt><dd><StatusBadge :status="selected.status" /></dd><dt>Project</dt><dd><span class="project-indicator" />{{ projectName(selected.project_id) }}</dd><dt>Provider</dt><dd><UIcon :name="providerName(selected) === 'Codex' ? 'i-lucide-sparkles' : 'i-lucide-flask-conical'" />{{ providerName(selected) === 'Codex' ? 'Codex' : 'Simulation' }}</dd><template v-for="stage in ['planningModel', 'implementationModel', 'reviewModel']" :key="stage"><dt>{{ stage === 'planningModel' ? 'Planning model' : stage === 'implementationModel' ? 'Implementation / repair' : 'Review model' }}</dt><dd>{{ JSON.parse(selected.provider_policy_json)[stage] ?? 'Catalog default' }}</dd></template><dt>Priority</dt><dd><UIcon :name="priorityIcon(selectedRequest?.priority ?? 'normal')" /><span class="capitalize">{{ selectedRequest?.priority ?? 'normal' }}</span></dd><dt>Created</dt><dd>{{ new Date(selected.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) }}</dd><dt>Updated</dt><dd>{{ relativeTime(selected.updated_at) }}</dd></dl><div class="property-divider" /><h3>Human checkpoints</h3><div class="checkpoint"><span :class="{ done: selected.approved_plan_revision_id }"><UIcon :name="selected.approved_plan_revision_id ? 'i-lucide-check' : 'i-lucide-lock-keyhole'" /></span><div>Plan approval<small>{{ selected.approved_plan_revision_id ? 'Authorized by you' : 'Required before implementation' }}</small></div></div><div class="checkpoint"><span :class="{ done: ['ACCEPTED','MERGED'].includes(selected.status) }"><UIcon :name="['ACCEPTED','MERGED'].includes(selected.status) ? 'i-lucide-check' : 'i-lucide-lock-keyhole'" /></span><div>Final acceptance<small>{{ ['ACCEPTED','MERGED'].includes(selected.status) ? 'Exact reviewed commit accepted' : 'Required before completion' }}</small></div></div><div v-if="selectedWorkspace" class="property-divider" /><template v-if="selectedWorkspace"><h3>Worktree</h3><button class="worktree-shortcut" @click="detailTab = 'changes'"><UIcon name="i-lucide-git-branch" /><span>{{ selectedWorkspace.branch }}</span><UIcon name="i-lucide-arrow-up-right" /></button></template><div class="property-footer"><UButton v-if="!['ACCEPTED','MERGED','REJECTED','CANCELLED'].includes(selected.status)" icon="i-lucide-circle-stop" color="error" variant="ghost" size="xs" :disabled="busy" @click="act({ type: 'task.cancel', taskId: selected.id, expectedVersion: selected.version, reason: 'Cancelled by the local user.' })">Cancel task</UButton><small v-if="selected.status === 'CANCELLED' && currentRun && ['queued','starting','running','stopping'].includes(currentRun.status)">Stopping the worker. Recovery unlocks after it stops.</small><small>History and artifacts are preserved.</small></div></aside></div>
    </template></template>
  </UModal>
</template>
