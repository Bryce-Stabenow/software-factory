export type DiffLineKind = 'context' | 'add' | 'remove' | 'hunk' | 'meta';

export interface DiffLine {
  text: string;
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffSection {
  path: string;
  oldPath: string | null;
  newPath: string | null;
  lines: DiffLine[];
  binary: boolean;
  unavailable: boolean;
}

function decodeGitQuotedPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;

  const source = value.slice(1, -1);
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const escapes: Record<string, number> = {
    a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92,
  };

  for (let index = 0; index < source.length; index++) {
    if (source[index] !== '\\') {
      const codePoint = source.codePointAt(index)!;
      bytes.push(...encoder.encode(String.fromCodePoint(codePoint)));
      if (codePoint > 0xffff) index++;
      continue;
    }

    const escaped = source[++index];
    if (escaped === undefined) {
      bytes.push(92);
    } else if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(source[index + 1] ?? '')) octal += source[++index];
      bytes.push(Number.parseInt(octal, 8));
    } else if (escaped in escapes) {
      bytes.push(escapes[escaped]);
    } else {
      bytes.push(...encoder.encode(escaped));
    }
  }

  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

function unquotePath(value: string): string {
  return decodeGitQuotedPath(value).replace(/^[ab]\//, '');
}

function diffPath(header: string): { oldPath: string | null; newPath: string | null } {
  const tokens = header.slice('diff --git '.length).match(/"(?:\\.|[^"])*"|\S+/g) ?? [];
  return {
    oldPath: tokens[0] ? unquotePath(tokens[0]) : null,
    newPath: tokens[1] ? unquotePath(tokens[1]) : null,
  };
}

function sectionFrom(raw: string[], fallback: string): DiffSection {
  const paths = diffPath(raw[0] ?? '');
  let oldLine = 0;
  let newLine = 0;
  let binary = false;

  const lines = raw.map(text => {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { text, kind: 'hunk' as const, oldLine: null, newLine: null };
    }
    if (/^(Binary files |GIT binary patch)/.test(text)) binary = true;
    if (text.startsWith('+') && !text.startsWith('+++')) {
      return { text, kind: 'add' as const, oldLine: null, newLine: newLine++ };
    }
    if (text.startsWith('-') && !text.startsWith('---')) {
      return { text, kind: 'remove' as const, oldLine: oldLine++, newLine: null };
    }
    if (text.startsWith(' ')) {
      return { text, kind: 'context' as const, oldLine: oldLine++, newLine: newLine++ };
    }
    return { text, kind: 'meta' as const, oldLine: null, newLine: null };
  });

  return {
    path: paths.newPath ?? paths.oldPath ?? fallback,
    oldPath: paths.oldPath,
    newPath: paths.newPath,
    lines,
    binary,
    unavailable: false,
  };
}

/** Splits Git's captured patch into independently viewable changed-file sections. */
export function parseDiff(diff: string, changedFiles: string[] = []): DiffSection[] {
  const chunks = (diff || '').replace(/\r\n/g, '\n').split(/(?=^diff --git )/m)
    .filter(chunk => chunk.startsWith('diff --git '));

  const sections = chunks.map((chunk, index) => {
    const lines = chunk.endsWith('\n') ? chunk.slice(0, -1).split('\n') : chunk.split('\n');
    return sectionFrom(lines, changedFiles[index] ?? ('Unknown file ' + (index + 1)));
  });

  for (const path of changedFiles) {
    if (!sections.some(section => section.path === path || section.oldPath === path || section.newPath === path)) {
      sections.push({ path, oldPath: null, newPath: null, lines: [], binary: false, unavailable: true });
    }
  }

  return sections;
}

/** Retains a valid selected file after inspection updates, falling back to the first file. */
export function reconcileSelectedFile(files: DiffSection[], selected: string | null): string | null {
  return files.some(file => file.path === selected) ? selected : files[0]?.path ?? null;
}

export interface DiffPair {
  old: DiffLine | null;
  next: DiffLine | null;
  fullWidth: boolean;
}

/** Aligns contiguous removal/addition blocks while keeping metadata and hunk boundaries intact. */
export function sideBySide(lines: DiffLine[]): DiffPair[] {
  const pairs: DiffPair[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.kind === 'remove' || line.kind === 'add') {
      const removed: DiffLine[] = [];
      const added: DiffLine[] = [];
      while (lines[index]?.kind === 'remove') removed.push(lines[index++]);
      while (lines[index]?.kind === 'add') added.push(lines[index++]);
      for (let pair = 0; pair < Math.max(removed.length, added.length); pair++) {
        pairs.push({ old: removed[pair] ?? null, next: added[pair] ?? null, fullWidth: false });
      }
      continue;
    }

    pairs.push({
      old: line,
      next: line.kind === 'context' ? line : null,
      fullWidth: line.kind !== 'context',
    });
    index++;
  }

  return pairs;
}
