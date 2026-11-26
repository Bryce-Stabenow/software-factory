import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, reconcileSelectedFile, sideBySide } from '../apps/desktop/src/diff-view.js';

const patch = `diff --git a/one.ts b/one.ts
index 1..2 100644
--- a/one.ts
+++ b/one.ts
@@ -2,2 +2,3 @@
 old
-old value
+new value
+another
diff --git a/two.txt b/two.txt
new file mode 100644
--- /dev/null
+++ b/two.txt
@@ -0,0 +1 @@
+hello
\\ No newline at end of file`;

test('parses files, hunks, and preserves old and new line numbers', () => {
  const files = parseDiff(patch);
  assert.deepEqual(files.map(file => file.path), ['one.ts', 'two.txt']);
  const changed = files[0].lines.filter(line => line.kind === 'remove' || line.kind === 'add');
  assert.deepEqual(changed.map(line => [line.kind, line.oldLine, line.newLine]), [['remove', 3, null], ['add', null, 3], ['add', null, 4]]);
});

test('reconciles uncaptured and binary changes without treating them as empty diffs', () => {
  const files = parseDiff('diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ', ['logo.png', 'untracked.txt']);
  assert.equal(files[0].binary, true);
  assert.equal(files[1].unavailable, true);
});

test('side-by-side pairs unequal replacement blocks and leaves blank cells', () => {
  const lines = parseDiff(patch)[0].lines;
  const pairs = sideBySide(lines).filter(pair => pair.old?.kind === 'remove' || pair.next?.kind === 'add');
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].old?.text, '-old value');
  assert.equal(pairs[0].next?.text, '+new value');
  assert.equal(pairs[1].old, null);
  assert.equal(pairs[1].next?.text, '+another');
});

test('keeps a valid selected file and falls back after a refresh', () => {
  const files = parseDiff(patch);
  assert.equal(reconcileSelectedFile(files, 'two.txt'), 'two.txt');
  assert.equal(reconcileSelectedFile(files, 'gone.txt'), 'one.ts');
  assert.equal(reconcileSelectedFile([], 'two.txt'), null);
});

test('reads quoted Git paths', () => {
  const files = parseDiff('diff --git "a/file name.ts" "b/file name.ts"\n--- "a/file name.ts"\n+++ "b/file name.ts"\n@@ -1 +1 @@\n-old\n+new');
  assert.equal(files[0].path, 'file name.ts');
});

test('decodes Git C-style octal path escapes as UTF-8', () => {
  const files = parseDiff('diff --git "a/\\303\\251.ts" "b/\\303\\251.ts"', ['é.ts']);
  assert.deepEqual(files.map(file => file.path), ['é.ts']);
});

test('keeps metadata and hunk boundaries to one side-by-side row', () => {
  const pairs = sideBySide(parseDiff(patch)[0].lines);
  const fullWidth = pairs.filter(pair => pair.fullWidth);
  assert.deepEqual(fullWidth.map(pair => pair.old?.text), [
    'diff --git a/one.ts b/one.ts',
    'index 1..2 100644',
    '--- a/one.ts',
    '+++ b/one.ts',
    '@@ -2,2 +2,3 @@',
  ]);
  assert.ok(fullWidth.every(pair => pair.next === null));
});

test('parses CRLF captures and keeps incomplete final hunks visible', () => {
  const files = parseDiff('diff --git a/partial.ts b/partial.ts\r\n--- a/partial.ts\r\n+++ b/partial.ts\r\n@@ -4 +4 @@\r\n-old');
  assert.equal(files[0].path, 'partial.ts');
  assert.deepEqual(files[0].lines.at(-1), {
    text: '-old',
    kind: 'remove',
    oldLine: 4,
    newLine: null,
  });
});

test('distinguishes a deleted file from an uncaptured changed file', () => {
  const files = parseDiff('diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old', ['gone.ts', 'untracked.ts']);
  assert.equal(files[0].path, 'gone.ts');
  assert.equal(files[0].unavailable, false);
  assert.equal(files[1].unavailable, true);
});

test('keeps a captured section selectable when changed-file metadata is incomplete', () => {
  const files = parseDiff('diff --git a/captured.ts b/captured.ts\n@@ -1 +1 @@\n-old\n+new', ['metadata-only.ts']);
  assert.deepEqual(files.map(file => file.path), ['captured.ts', 'metadata-only.ts']);
  assert.equal(reconcileSelectedFile(files, 'captured.ts'), 'captured.ts');
});
