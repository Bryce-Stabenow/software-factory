import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(root, 'apps/desktop');
// The small sidebar mark is the single source for every app-icon size.
const mark = readFileSync(resolve(desktop, 'public/kulumin-mark.svg'), 'utf8');
const geometry = mark.slice(mark.indexOf('>') + 1, mark.lastIndexOf('</svg>')).trim();
writeFileSync(resolve(desktop, 'public/kulumin-icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="none">
  <rect x="64" y="64" width="896" height="896" rx="208" fill="#171717"/>
  <g transform="translate(64 64) scale(14)">
${geometry}
  </g>
</svg>\n`);
copyFileSync(resolve(desktop, 'public/kulumin-icon.svg'), resolve(desktop, 'src-tauri/app-icon.svg'));
execFileSync(process.execPath, [resolve(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', 'public/kulumin-icon.svg', '--output', 'src-tauri/icons', ...[32, 128, 256, 512, 1024].flatMap(size => ['--png', String(size)])], { cwd: desktop, stdio: 'inherit' });

// Tauri's macOS PNG fallback cannot encode every high-resolution slot.
// Generate an explicit ICNS with the CLI so Finder and Dock get all sizes.
const temporary = mkdtempSync(resolve(tmpdir(), 'kulumin-icons-'));
try {
  execFileSync(process.execPath, [resolve(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', 'public/kulumin-icon.svg', '--output', temporary], { cwd: desktop, stdio: 'pipe' });
  copyFileSync(resolve(temporary, 'icon.icns'), resolve(desktop, 'src-tauri/icons/icon.icns'));
} finally { rmSync(temporary, { recursive: true, force: true }); }
