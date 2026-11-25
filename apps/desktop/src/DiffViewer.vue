<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ diff: string }>();
const lines = computed(() => {
  let oldLine = 0, newLine = 0;
  return (props.diff || 'No changes from the base commit.').split('\n').map(text => {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    let kind = '', before: number | string = '', after: number | string = '';
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); kind = 'hunk'; }
    else if (/^(diff |index |--- |\+\+\+ |new file|deleted file)/.test(text)) kind = 'file';
    else if (text.startsWith('+')) { kind = 'add'; after = newLine++; }
    else if (text.startsWith('-')) { kind = 'remove'; before = oldLine++; }
    else if (text.startsWith(' ')) { before = oldLine++; after = newLine++; }
    return { text, kind, before, after };
  });
});
</script>
<template><div class="diff-container" role="region" aria-label="Git diff" tabindex="0"><pre><span v-for="(line, index) in lines" :key="index" class="diff-line" :class="line.kind"><span aria-hidden="true">{{ line.before }}</span><span aria-hidden="true">{{ line.after }}</span><span>{{ line.text }}</span></span></pre></div></template>
