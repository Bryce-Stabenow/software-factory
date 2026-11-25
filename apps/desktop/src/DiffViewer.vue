<script setup lang="ts">
import { computed } from 'vue';
import type { DiffSection } from './diff-view';
import { sideBySide } from './diff-view';
const props = defineProps<{ section: DiffSection; mode: 'inline' | 'side-by-side' }>();
const pairs = computed(() => sideBySide(props.section.lines));
</script>
<template>
  <div class="diff-container" role="region" aria-label="Selected file diff" tabindex="0">
    <pre v-if="mode === 'inline'"><span v-for="(line, index) in section.lines" :key="index" class="diff-line" :class="line.kind"><span>{{ line.oldLine ?? '' }}</span><span>{{ line.newLine ?? '' }}</span><span>{{ line.text }}</span></span></pre>
    <div v-else class="side-by-side"><div v-for="(pair, index) in pairs" :key="index" class="diff-pair" :class="{ 'full-width': pair.fullWidth }"><span v-if="pair.fullWidth" class="diff-cell" :class="pair.old?.kind"><code>{{ pair.old?.text ?? '' }}</code></span><template v-else><span class="diff-cell" :class="pair.old?.kind"><i>{{ pair.old?.oldLine ?? '' }}</i><code>{{ pair.old?.text ?? '' }}</code></span><span class="diff-cell" :class="pair.next?.kind"><i>{{ pair.next?.newLine ?? '' }}</i><code>{{ pair.next?.text ?? '' }}</code></span></template></div></div>
  </div>
</template>