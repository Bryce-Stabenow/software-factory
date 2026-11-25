import type { ProviderHealth } from '../../../packages/contracts/src/index';
export function modelSelectionItems(selected: string | null | undefined, models: ProviderHealth['models'], inherit = false, projectDefault?: string | null) {
  const catalog = models ?? [];
  const items = [
    ...(inherit ? [{ label: 'Use project default (' + (projectDefault ?? 'Catalog default') + ')', value: 'inherit' }] : []),
    { label: 'Catalog default' + (catalog.find(model => model.isDefault) ? ' (' + catalog.find(model => model.isDefault)!.name + ')' : ''), value: 'catalog' },
    ...catalog.map(model => ({ label: model.name, value: 'model:' + model.model })),
  ];
  if (selected && !catalog.some(model => model.model === selected)) items.push({ label: selected + ' (not in current catalog)', value: 'model:' + selected });
  return items;
}
export const encodeModelSelection = (value: string | null | undefined) => value === undefined ? 'inherit' : value === null ? 'catalog' : 'model:' + value;
export const decodeModelSelection = (value: string): string | null | undefined => value === 'inherit' ? undefined : value === 'catalog' ? null : value.slice(6);
