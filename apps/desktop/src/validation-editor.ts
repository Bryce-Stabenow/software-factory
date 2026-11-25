import { executionConfigSchema, type ExecutionConfig } from '../../../packages/contracts/src/index';
export type CheckDraft = { name: string; command: string; timeoutSeconds: number };

// This is an argument tokenizer, never a shell. Quoted text stays one argument.
export function parseCheckCommand(text: string): string[] {
  const argv: string[] = [];
  let token = '', quote = '', started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"') {
        if (++index === text.length) throw new Error('Finish the escaped character in the command.');
        token += text[index];
      } else token += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === '\\') {
      if (++index === text.length) throw new Error('Finish the escaped character in the command.');
      token += text[index]; started = true;
    } else if (/\s/.test(char)) {
      if (started) { argv.push(token); token = ''; started = false; }
    } else {
      if (/[|&;<>()`]/.test(char)) throw new Error('Add each check separately. Shell chaining, pipes, and redirection are not supported.');
      token += char; started = true;
    }
  }
  if (quote) throw new Error('Close the quotation mark in the command.');
  if (started) argv.push(token);
  if (!argv.length || !argv[0].trim()) throw new Error('Enter a command, such as npm test.');
  return argv;
}
export function formatCheckCommand(argv: string[]): string {
  return argv.map(arg => /^[a-zA-Z0-9_./:@%+=,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
}
export function buildExecutionConfig(checks: CheckDraft[], settings: Omit<ExecutionConfig, 'validationCommands'>): ExecutionConfig {
  const commands = checks.map((check, index) => {
    if (!check.name.trim()) throw new Error(`Give check ${index + 1} a name.`);
    try { return { name: check.name.trim(), argv: parseCheckCommand(check.command), timeoutMs: Math.round(Number(check.timeoutSeconds) * 1000) }; }
    catch (error) { throw new Error(`${check.name}: ${(error as Error).message}`); }
  });
  if (new Set(commands.map(check => check.name)).size !== commands.length) throw new Error('Give each check a different name.');
  if (settings.executionEnabled && !commands.length) throw new Error('Add at least one validation check before enabling implementation, or save this project for planning only.');
  const parsed = executionConfigSchema.safeParse({ ...settings, validationCommands: commands });
  if (!parsed.success) throw new Error('Check timeouts must be 0.1–300 seconds, the implementation timeout 1–30 minutes, and the attempt limit 1–5. Use no more than 12 checks.');
  if (parsed.data.executionEnabled && !parsed.data.trustedRepository) throw new Error('Trust this repository before enabling implementation.');
  return parsed.data;
}
