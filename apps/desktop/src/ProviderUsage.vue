<script setup lang="ts">
import type { ProviderUsage } from '../../../packages/contracts/src/index';
import { localUsageTime, remainingText, resetText, windowLabel } from './provider-usage';
defineProps<{ usage?: ProviderUsage; loading: boolean; refreshError?: string }>();
defineEmits<{ refresh: [] }>();
</script>

<template>
  <section class="provider-usage" aria-label="Codex usage" :aria-busy="loading">
    <div class="usage-heading">
      <h4>Usage allowance</h4>
      <button type="button" class="usage-refresh" :disabled="loading" @click="$emit('refresh')">{{ loading ? 'Refreshing…' : 'Refresh usage' }}</button>
    </div>
    <p v-if="loading" role="status">Checking Codex usage…</p>
    <p v-else-if="refreshError" role="alert">{{ refreshError }}</p>
    <template v-else>
      <p role="status">{{ usage?.explanation ?? 'Usage has not been checked yet.' }}</p>
      <div v-if="usage?.status === 'ready'" class="usage-groups">
        <section v-for="group in usage.groups" :key="group.id" class="usage-group">
          <h5>{{ group.name ?? 'Codex limits' }}</h5>
          <p>{{ group.scope === 'model' && group.model ? 'Model: ' + group.model : 'Shared account limits · not per-model usage' }}</p>
          <p v-if="group.plan">Plan: {{ group.plan }}</p>
          <div class="usage-windows">
            <div v-for="window in group.windows" :key="window.id" class="usage-window">
              <div class="usage-window-heading"><span>{{ windowLabel(window) }}</span><strong>{{ remainingText(window.remainingPercent) }}</strong></div>
              <progress v-if="window.remainingPercent !== null" :value="window.remainingPercent" max="100" :aria-label="(group.name ?? 'Codex limits') + ' · ' + windowLabel(window)" :aria-valuetext="remainingText(window.remainingPercent)">{{ remainingText(window.remainingPercent) }}</progress>
              <p>{{ resetText(window.resetsAt) }}</p>
            </div>
          </div>
          <p v-if="group.credits?.unlimited === true">Credits: unlimited</p>
          <p v-else-if="group.credits?.balance !== null && group.credits?.balance !== undefined">Credit balance: {{ group.credits.balance }} (provider units)</p>
          <p v-else-if="group.credits?.hasCredits !== null && group.credits?.hasCredits !== undefined">{{ group.credits.hasCredits ? 'Credits available' : 'No credits available' }}</p>
        </section>
      </div>
    </template>
    <p v-if="usage" class="usage-checked">Last checked: <time :datetime="usage.checkedAt">{{ localUsageTime(usage.checkedAt) }}</time></p>
    <p v-if="usage?.status === 'ready' && !loading && !refreshError" class="usage-note">Allowance may change elsewhere. A reset time passing does not update this snapshot; refresh to check again.</p>
  </section>
</template>
