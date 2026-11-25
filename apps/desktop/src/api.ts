import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Command, Response } from '../../../packages/contracts/src/index';

export async function command<T>(payload: Command): Promise<T> {
  let result: Response<T>;
  if (isTauri()) result = await invoke<Response<T>>('factory_command', { command: payload });
  else {
    const response = await fetch('/__factory', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Factory-Client': 'local-development' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`Factory service unavailable (${response.status}). Start the development server with npm run dev.`);
    result = await response.json();
  }
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

export const nativeDesktop = isTauri();
export async function restartService() {
  if (!nativeDesktop) throw new Error('Restart the development server from its terminal.');
  await invoke('factory_restart');
}
