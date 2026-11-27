import type { ProviderUsage, ProviderUsageWindow } from '../../../packages/contracts/src/index';

export function usageNeedsRefresh(usage: ProviderUsage | undefined, now = Date.now()): boolean {
  const checked = usage ? Date.parse(usage.checkedAt) : NaN;
  return !Number.isFinite(checked) || now - checked > 60000;
}
export function remainingText(value: number | null): string {
  if (value === null) return 'Percentage unavailable';
  if (value > 0 && value < 0.1) return '<0.1% left';
  if (value < 100 && value > 99.9) return '>99.9% left';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value) + '% left';
}
export function windowLabel(window: ProviderUsageWindow): string {
  const minutes = window.durationMinutes;
  const position = window.id === 'primary' ? 'Primary window' : 'Secondary window';
  if (minutes === null) return position + ' · duration unknown';
  const [amount, unit] = minutes % 1440 === 0 ? [minutes / 1440, 'day'] : minutes % 60 === 0 ? [minutes / 60, 'hour'] : [minutes, 'minute'];
  return position + ' · ' + new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(amount as number) + ' ' + unit + (amount === 1 ? '' : 's');
}
export function localUsageTime(value: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unknown';
}
export function resetText(value: string | null, now = Date.now()): string {
  if (!value) return 'Reset time unavailable';
  return (Date.parse(value) <= now ? 'Reported reset: ' : 'Resets: ') + localUsageTime(value);
}
