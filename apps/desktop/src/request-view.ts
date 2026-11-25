import { statuses, type Request, type Task } from '../../../packages/contracts/src/index.js';
import { issueId, statusMeta } from './presentation.js';

export type RequestGrouping = 'status' | 'project';
type LinkedTask = Pick<Task, 'status' | 'provider_policy_json'>;
export type RequestTaskLookup = (requestId: string) => LinkedTask | undefined;
export interface RequestFilters {
  hideCompleted?: boolean;
  archive?: string;
  query?: string;
  projectId?: string;
  priority?: string;
  provider?: string;
  attentionOnly?: boolean;
}
export function isRequestCompleted(task: Pick<Task, 'status'> | undefined): boolean {
  return task?.status === 'ACCEPTED' || task?.status === 'MERGED';
}
export function filterRequests(requests: readonly Request[], taskFor: RequestTaskLookup, filters: RequestFilters = {}): Request[] {
  return requests.filter(request => {
    const task = taskFor(request.id);
    return (!(filters.hideCompleted ?? true) || !isRequestCompleted(task))
      && ((filters.archive ?? 'open') === 'all' || request.status === (filters.archive ?? 'open'))
      && (!filters.projectId || request.project_id === filters.projectId)
      && (!filters.priority || filters.priority === 'all' || request.priority === filters.priority)
      && (!filters.provider || filters.provider === 'all' || !!task && JSON.parse(task.provider_policy_json).provider === filters.provider)
      && (!filters.attentionOnly || !!task && ['PLAN_REVIEW', 'FINAL_REVIEW', 'PLANNING_BLOCKED', 'BLOCKED', 'FAILED'].includes(task.status))
      && `${request.title} ${request.id} ${issueId(request.id)} REQ-${request.id.slice(0, 5)}`.toLowerCase().includes((filters.query ?? '').toLowerCase());
  });
}
export interface RequestGroup { key: string; label: string; requests: Request[] }
export function groupRequests(requests: readonly Request[], taskFor: RequestTaskLookup, grouping: RequestGrouping, projectName: (id: string) => string): RequestGroup[] {
  const groups = new Map<string, RequestGroup>();
  for (const request of requests) {
    const status = taskFor(request.id)?.status;
    const key = grouping === 'project' ? request.project_id : status ?? 'saved';
    let group = groups.get(key);
    if (!group) {
      group = { key, label: grouping === 'project' ? projectName(key) : status ? statusMeta(status).label : 'Saved for later', requests: [] };
      groups.set(key, group);
    }
    group.requests.push(request);
  }
  // Projects retain first appearance order; statuses follow the contract, then taskless requests.
  return grouping === 'project' ? [...groups.values()] : [...statuses, 'saved'].flatMap(key => {
    const group = groups.get(key);
    return group ? [group] : [];
  });
}
