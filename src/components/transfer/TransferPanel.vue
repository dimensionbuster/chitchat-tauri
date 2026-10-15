<script setup lang="ts">
defineOptions({ name: 'TransferPanel' })
import { computed, ref } from 'vue'
import { useFileTransferProgress, type FileTransferProgress } from '@/composables/useFileTransferProgress'

const emit = defineEmits<{
  cancel: [fileId: string]
  retry: [fileId: string]
}>()

const { transfers, importing } = useFileTransferProgress()
const expanded = ref(true)

// 완료된 항목은 잠깐 보였다가 서비스가 목록에서 지운다. 여기서는 있는 그대로 보여준다.
const items = computed(() => transfers.value)
const visible = computed(() => items.value.length > 0 || importing.value !== null)
const activeCount = computed(() => items.value.filter(t => t.state !== 'done' && t.state !== 'error').length)

const STATE_LABEL: Record<FileTransferProgress['state'], string> = {
  queued: '대기 중',
  waiting: '파일을 가진 접속자를 기다리는 중',
  active: '',
  verifying: '무결성 검사 중',
  done: '완료',
  error: '실패',
}

const ERROR_LABEL: Record<string, string> = {
  'no-space': '디스크 공간이 부족합니다',
  corrupt: '받은 파일이 손상되어 있습니다',
  cancelled: '취소됨',
  closed: '채팅방이 닫혔습니다',
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function percent(t: FileTransferProgress): number {
  return t.totalBytes > 0 ? Math.min(100, (t.receivedBytes / t.totalBytes) * 100) : 0
}

function statusText(t: FileTransferProgress): string {
  if (t.state === 'error') return ERROR_LABEL[t.error ?? ''] ?? t.error ?? '실패'
  if (t.state === 'active') {
    const speed = t.speed > 0 ? `${formatBytes(t.speed)}/s` : ''
    const peers = t.peers > 1 ? `${t.peers}명에게서` : ''
    return [speed, peers].filter(Boolean).join(' · ')
  }
  return STATE_LABEL[t.state]
}

const importPercent = computed(() => {
  const info = importing.value
  return info && info.total > 0 ? Math.min(100, (info.done / info.total) * 100) : 0
})
</script>

<template>
  <div v-if="visible" class="transfer-panel">
    <button class="panel-header" @click="expanded = !expanded">
      <span>📶 파일 전송 {{ activeCount > 0 ? `(${activeCount})` : '' }}</span>
      <span class="chevron">{{ expanded ? '▾' : '▴' }}</span>
    </button>

    <div v-if="expanded" class="panel-body">
      <div v-if="importing" class="item">
        <div class="row">
          <span class="name">{{ importing.name }}</span>
          <span class="meta">준비 중 {{ importPercent.toFixed(0) }}%</span>
        </div>
        <div class="bar"><div class="fill" :style="{ width: importPercent + '%' }" /></div>
      </div>

      <div v-for="t in items" :key="`${t.type}-${t.fileId}`" class="item" :class="{ error: t.state === 'error' }">
        <div class="row">
          <span class="name">{{ t.type === 'upload' ? '⬆' : '⬇' }} {{ t.fileName }}</span>
          <span class="meta">{{ formatBytes(t.receivedBytes) }} / {{ formatBytes(t.totalBytes) }}</span>
        </div>
        <div class="bar"><div class="fill" :class="t.state" :style="{ width: percent(t) + '%' }" /></div>
        <div class="row sub">
          <span>{{ statusText(t) }}</span>
          <span class="actions">
            <button v-if="t.state === 'error' && t.type === 'download'" @click="emit('retry', t.fileId)">다시 시도</button>
            <button v-if="t.type === 'download' && t.state !== 'done'" @click="emit('cancel', t.fileId)">취소</button>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.transfer-panel {
  position: fixed;
  right: var(--spacing-md, 12px);
  bottom: var(--spacing-md, 12px);
  width: 320px;
  max-height: 50vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-card, #1c1f2b);
  border: 1px solid var(--border-light, rgba(255, 255, 255, 0.12));
  border-radius: var(--radius-lg, 10px);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  color: var(--text-primary, #fff);
  z-index: 1000;
  overflow: hidden;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  padding: 8px 12px;
  background: transparent;
  border: none;
  color: inherit;
  font-size: var(--font-size-sm, 13px);
  font-weight: 600;
  cursor: pointer;
}

.panel-body {
  overflow-y: auto;
  padding: 0 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.row.sub {
  margin-top: 3px;
  color: var(--text-secondary, rgba(255, 255, 255, 0.65));
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  flex-shrink: 0;
  color: var(--text-secondary, rgba(255, 255, 255, 0.65));
}

.bar {
  height: 5px;
  margin-top: 4px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  overflow: hidden;
}

.fill {
  height: 100%;
  background: var(--color-primary, #7c5cff);
  transition: width 0.2s ease;
}

.fill.waiting,
.fill.queued {
  background: rgba(255, 255, 255, 0.3);
}

.fill.error {
  background: #e5484d;
}

.fill.done {
  background: #30a46c;
}

.item.error .sub {
  color: #e5484d;
}

.actions button {
  margin-left: 6px;
  padding: 0 6px;
  font-size: 11px;
  background: transparent;
  border: 1px solid var(--border-default, rgba(255, 255, 255, 0.25));
  border-radius: 4px;
  color: inherit;
  cursor: pointer;
}
</style>
