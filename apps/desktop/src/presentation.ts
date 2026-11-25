export type StatusColor = 'neutral' | 'primary' | 'info' | 'success' | 'warning' | 'error';
export function statusMeta(status: string): { label: string; icon: string; color: StatusColor } {
  const label = status.toLowerCase().split('_').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
  if (['PLAN_REVIEW','FINAL_REVIEW'].includes(status)) return { label, icon: 'i-lucide-circle-dot', color: 'warning' };
  if (['ACCEPTED','MERGED','passed','succeeded'].includes(status)) return { label, icon: 'i-lucide-circle-check', color: 'success' };
  if (['BLOCKED','FAILED','REJECTED','failed','timed_out','stale'].includes(status)) return { label, icon: 'i-lucide-circle-alert', color: 'error' };
  if (['BUILDING','VALIDATING','REPAIRING','PLANNING','CODE_REVIEW','running','starting'].includes(status)) return { label, icon: 'i-lucide-loader-circle', color: 'primary' };
  if (['CANCELLED','cancelled','interrupted'].includes(status)) return { label, icon: 'i-lucide-circle-x', color: 'neutral' };
  return { label, icon: 'i-lucide-circle-dashed', color: 'neutral' };
}
export const kindIcon = (kind: string) => kind === 'bug' ? 'i-lucide-bug' : kind === 'chore' ? 'i-lucide-wrench' : kind === 'refactor' ? 'i-lucide-git-merge' : 'i-lucide-diamond';
export const priorityIcon = (priority: string) => priority === 'high' ? 'i-lucide-signal' : priority === 'low' ? 'i-lucide-signal-low' : 'i-lucide-signal-medium';
export const issueId = (id: string) => `KUL-${id.slice(0,6).toUpperCase()}`;
export const relativeTime = (value: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
};
