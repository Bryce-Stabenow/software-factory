export type DiffLineKind = 'context' | 'add' | 'remove' | 'hunk' | 'meta';
export interface DiffLine { text: string; kind: DiffLineKind; oldLine: number | null; newLine: number | null; }
export interface DiffSection { path: string; oldPath: string | null; newPath: string | null; lines: DiffLine[]; binary: boolean; unavailable: boolean; }
const unquotePath = (value: string) => {
  const path = value.replace(/^[ab]\//, '');
  if (!path.startsWith('"')) return path;
  try { return JSON.parse(path); } catch { return path.slice(1, -1).replace(/\\(["\\])/g, '$1'); }
};
function diffPath(header: string): { oldPath: string | null; newPath: string | null } {
  const match = header.match(/^diff --git (.+) (.+)$/);
  if (!match) return { oldPath: null, newPath: null };
  const parts = match[1].startsWith('"') ? [...match[1].matchAll(/"((?:\\.|[^"])*)"|([^ ]+)/g)].map(item => item[1] ?? item[2]) : match.slice(1);
  return { oldPath: parts[0] ? unquotePath(parts[0]) : null, newPath: parts[1] ? unquotePath(parts[1]) : null };
}
function sectionFrom(raw: string[], fallback: string): DiffSection {
  const paths = diffPath(raw[0] ?? ''); let oldLine = 0, newLine = 0, binary = false;
  const lines = raw.map(text => {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return { text, kind: 'hunk' as const, oldLine: null, newLine: null }; }
    if (/^(Binary files |GIT binary patch)/.test(text)) binary = true;
    if (text.startsWith('+') && !text.startsWith('+++')) return { text, kind: 'add' as const, oldLine: null, newLine: newLine++ };
    if (text.startsWith('-') && !text.startsWith('---')) return { text, kind: 'remove' as const, oldLine: oldLine++, newLine: null };
    if (text.startsWith(' ')) return { text, kind: 'context' as const, oldLine: oldLine++, newLine: newLine++ };
    return { text, kind: 'meta' as const, oldLine: null, newLine: null };
  });
  const oldPath = raw.find(line => line.startsWith('--- '))?.slice(4), newPath = raw.find(line => line.startsWith('+++ '))?.slice(4);
  return { path: paths.newPath ?? paths.oldPath ?? (newPath && newPath !== '/dev/null' ? unquotePath(newPath) : oldPath ? unquotePath(oldPath) : fallback), oldPath: paths.oldPath, newPath: paths.newPath, lines, binary, unavailable: false };
}
export function parseDiff(diff: string, changedFiles: string[] = []): DiffSection[] {
  const chunks = (diff || '').split(/(?=^diff --git )/m).filter(chunk => chunk.startsWith('diff --git '));
  const sections = chunks.map((chunk, index) => sectionFrom(chunk.replace(/\n$/, '').split('\n'), changedFiles[index] ?? `Unknown file ${index + 1}`));
  for (const path of changedFiles) if (!sections.some(section => section.path === path || section.oldPath === path || section.newPath === path)) sections.push({ path, oldPath: null, newPath: null, lines: [], binary: false, unavailable: true });
  return sections;
}
export function reconcileSelectedFile(files: DiffSection[], selected: string | null): string | null {
  return files.some(file => file.path === selected) ? selected : files[0]?.path ?? null;
}
export interface DiffPair { old: DiffLine | null; next: DiffLine | null; }
export function sideBySide(lines: DiffLine[]): DiffPair[] {
  const pairs: DiffPair[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.kind === 'remove' || line.kind === 'add') {
      const removed: DiffLine[] = [], added: DiffLine[] = [];
      while (lines[index]?.kind === 'remove') removed.push(lines[index++]);
      while (lines[index]?.kind === 'add') added.push(lines[index++]);
      for (let pair = 0; pair < Math.max(removed.length, added.length); pair++) pairs.push({ old: removed[pair] ?? null, next: added[pair] ?? null });
    } else { pairs.push({ old: line, next: line }); index++; }
  }
  return pairs;
}