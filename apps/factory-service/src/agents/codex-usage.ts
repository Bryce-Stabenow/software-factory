import type { ProviderUsage, ProviderUsageGroup, ProviderUsageWindow } from '../../../../packages/contracts/src/index.js';

// Compatibility boundary: account/rateLimits/read uses camelCase snapshots,
// primary/secondary windows, minutes for durations and Unix seconds for resets.
// Unknown fields (including account identifiers and speculative model attribution)
// never cross this boundary. See docs/implementation-status.md.
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export function usageState(status: ProviderUsage['status'], explanation: string, checkedAt = new Date().toISOString()): ProviderUsage {
  return { status, checkedAt, explanation, groups: [] };
}
function label(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9 ._()/+-]{0,99}$/.test(value) ? value : null;
}
function window(value: unknown, id: ProviderUsageWindow['id']): ProviderUsageWindow | null {
  const source = record(value);
  if (!source) return null;
  const used = source.usedPercent, minutes = source.windowDurationMins, reset = source.resetsAt;
  // Never guess milliseconds, parse numeric strings, or replenish an expired window.
  const date = finite(reset) && reset >= 0 && reset <= 253402300799 ? new Date(reset * 1000).toISOString() : null;
  return {
    id, remainingPercent: finite(used) ? Math.max(0, Math.min(100, 100 - used)) : null,
    durationMinutes: finite(minutes) && minutes > 0 ? minutes : null, resetsAt: date,
  };
}
function group(value: unknown, key: string): ProviderUsageGroup | null {
  const source = record(value);
  if (!source) return null;
  const windows = (['primary', 'secondary'] as const).flatMap(id => {
    const result = window(source[id], id);
    return result ? [result] : [];
  });
  const credits = record(source.credits);
  const balance = credits?.balance;
  const normalizedCredits = credits ? {
    hasCredits: typeof credits.hasCredits === 'boolean' ? credits.hasCredits : null,
    unlimited: typeof credits.unlimited === 'boolean' ? credits.unlimited : null,
    balance: typeof balance === 'string' && /^\d{1,20}(\.\d{1,10})?$/.test(balance) ? balance : null,
  } : null;
  const plan = typeof source.planType === 'string' && ['free', 'go', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu'].includes(source.planType) ? source.planType : null;
  if (!windows.some(window => window.remainingPercent !== null || window.durationMinutes !== null || window.resetsAt !== null) && !plan && (!normalizedCredits || Object.values(normalizedCredits).every(value => value === null))) return null;
  return { id: key, name: label(source.limitName) ?? label(source.limitId) ?? label(key), scope: 'shared', model: null, windows, plan, credits: normalizedCredits };
}
export function normalizeCodexUsage(value: unknown, checkedAt = new Date().toISOString()): ProviderUsage {
  const source = record(value);
  if (!source) return usageState('error', 'Codex returned an invalid usage response. Try refreshing.', checkedAt);
  const groups: ProviderUsageGroup[] = [];
  const named = record(source.rateLimitsByLimitId);
  if (named) for (const [key, value] of Object.entries(named)) {
    const result = group(value, key);
    // UI IDs are local; provider names/keys only pass through the bounded label filter.
    if (result) groups.push({ ...result, id: 'limit-' + groups.length });
  }
  const legacy = group(source.rateLimits, 'Account limits');
  if (legacy) {
    const legacyId = record(source.rateLimits)?.limitId;
    const matchesId = typeof legacyId === 'string' && named && Object.entries(named).some(([key, value]) =>
      (key === legacyId || record(value)?.limitId === legacyId) && group(value, key));
    const sameAllowance = groups.some(item => JSON.stringify([item.windows, item.plan, item.credits]) === JSON.stringify([legacy.windows, legacy.plan, legacy.credits]));
    if (!matchesId && !sameAllowance) groups.push({ ...legacy, id: 'legacy' });
  }
  if (!groups.length) {
    const missing = source.rateLimits == null && source.rateLimitsByLimitId == null ||
      source.rateLimits == null && named && !Object.keys(named).length;
    return usageState(missing ? 'unavailable' : 'error', missing ? 'Codex did not provide usage analytics for this account.' : 'Codex returned no usable usage information. Try refreshing.', checkedAt);
  }
  return { status: 'ready', checkedAt, explanation: 'Current allowance reported by Codex. Limits are shared; per-model usage is not supplied by this protocol.', groups };
}
