<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ConnectedUser } from '@/composables/useConnectedUsers'
import HeaderDrawer from '@/components/drawer/HeaderDrawer.vue'

defineOptions({ name: 'ChatHeader' })

const props = defineProps<{
  roomId: string
  /** 네트워크 상태: 연결 여부 / 연결된 피어 수 / 문서 동기화를 받았는지 */
  net?: { connected: boolean; peers: number; synced: boolean }
  userCount?: number
  connectedUsers?: ConnectedUser[]
  isElectron?: boolean
}>()

const emit = defineEmits<{
  export: []
  import: []
  reload: []
  forceResync: []
  goHome: []
  clearChat: []
  resetAll: []
  closeChatRoom: []
  openWatchParty: []
}>()

const showUserList = ref(false)

// 연결 상태 표시: 사용자가 "왜 아무도 안 보이는지" 알 수 있도록 상태별 안내를 준다.
const netState = computed(() => {
  const net = props.net
  if (!net || !net.connected) {
    return { level: 'off', label: '오프라인', hint: '네트워크에 연결되어 있지 않습니다. 쓴 글은 연결되면 자동으로 동기화됩니다.' }
  }
  if (net.peers === 0) {
    return {
      level: 'wait',
      label: '접속자를 찾는 중',
      hint: '같은 방에 있는 다른 사람을 찾고 있습니다. 한참 지나도 연결되지 않으면 상대 또는 내 네트워크(공유기/방화벽)가 직접 연결(P2P)을 막고 있을 수 있습니다.',
    }
  }
  return { level: 'ok', label: `연결됨 (${net.peers}명)`, hint: net.synced ? '대화 기록이 동기화되었습니다.' : '대화 기록을 동기화하는 중입니다.' }
})

const toggleUserList = () => {
  showUserList.value = !showUserList.value
}
</script>

<template>
  <div class="chat-header">
    <div class="title-section">
      <h1 class="room-title">
        <span class="room-icon">💬</span>
        {{ roomId }}
      </h1>
      <span class="net-status" :class="netState.level" :title="netState.hint">
        <span class="net-dot"></span>{{ netState.label }}
      </span>
      <button
        class="user-count-btn"
        @click="toggleUserList"
        :title="`접속자 ${userCount || 0}명`"
      >
        <span class="user-icon">👥</span>
        <span class="user-count">{{ userCount || 0 }}</span>
      </button>

      <!-- 접속자 목록 팝업 -->
      <Transition name="popup">
        <div v-if="showUserList" class="user-list-popup">
          <div class="user-list-header">
            <h3>접속자 목록 ({{ userCount || 0 }}명)</h3>
            <button class="close-btn" @click="showUserList = false">✕</button>
          </div>
          <div class="user-list-content">
            <div v-if="!connectedUsers || connectedUsers.length === 0" class="no-users">
              다른 접속자가 없습니다
            </div>
            <div v-else class="user-item" v-for="user in connectedUsers" :key="user.clientId">
              <div class="user-info">
                <div class="user-nickname">{{ user.nickname }}</div>
                <div class="user-uuid" :title="user.userUuid">{{ user.userUuid }}</div>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </div>

    <HeaderDrawer
      :roomId="roomId"
      :isElectron="isElectron"
      @export="emit('export')"
      @import="emit('import')"
      @reload="emit('reload')"
      @resync="emit('forceResync')"
      @goHome="emit('goHome')"
      @closeChatRoom="emit('closeChatRoom')"
      @openWatchParty="emit('openWatchParty')"
    />
  </div>
</template>

<style scoped>
.chat-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  backdrop-filter: blur(var(--bg-blur-chat, 10px));
  position: relative;
  z-index: 1;
}

.title-section {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  position: relative;
}

.room-title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--color-secondary);
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.room-icon {
  font-size: var(--font-size-xl);
}

.user-count-btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-md);
  background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-accent) 100%);
  color: white;
  border: none;
  border-radius: var(--radius-full);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: all var(--transition-fast);
  box-shadow: 0 2px 8px rgba(var(--color-primary-rgb), 0.3);
}

.user-count-btn:hover {
  background: linear-gradient(135deg, var(--color-secondary) 0%, var(--color-primary) 100%);
  box-shadow: 0 4px 16px rgba(var(--color-primary-rgb), 0.4);
  transform: scale(1.05);
}

.net-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  cursor: help;
}

.net-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #8a8f98;
}

.net-status.ok .net-dot {
  background: #30a46c;
}

.net-status.wait .net-dot {
  background: #f5a524;
  animation: net-pulse 1.4s ease-in-out infinite;
}

.net-status.off .net-dot {
  background: #e5484d;
}

@keyframes net-pulse {
  50% {
    opacity: 0.35;
  }
}

.user-icon {
  font-size: var(--font-size-base);
}

.user-count {
  min-width: 16px;
  text-align: center;
  color: white;
}

.user-list-popup {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: var(--spacing-sm);
  background: var(--bg-card-solid);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  min-width: 300px;
  max-width: 400px;
  z-index: var(--z-dropdown);
  overflow: hidden;
}

.user-list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md) var(--spacing-lg);
  background: linear-gradient(135deg, var(--color-primary-light) 0%, var(--bg-secondary) 100%);
  border-bottom: 1px solid var(--color-accent);
}

.user-list-header h3 {
  margin: 0;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--color-secondary);
}

.close-btn {
  padding: var(--spacing-xs);
  background: transparent;
  border: none;
  font-size: var(--font-size-lg);
  color: var(--text-secondary);
  cursor: pointer;
  line-height: 1;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
}

.close-btn:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

.user-list-content {
  max-height: 400px;
  overflow-y: auto;
}

.no-users {
  padding: var(--spacing-2xl) var(--spacing-lg);
  text-align: center;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.user-item {
  padding: var(--spacing-md) var(--spacing-lg);
  border-bottom: 1px solid var(--border-light);
  transition: background var(--transition-fast);
}

.user-item:last-child {
  border-bottom: none;
}

.user-item:hover {
  background: rgba(var(--color-primary-rgb), 0.08);
}

.user-info {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.user-nickname {
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  font-size: var(--font-size-base);
}

.user-uuid {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  font-family: var(--font-family-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Popup Animation */
.popup-enter-active,
.popup-leave-active {
  transition: all var(--transition-normal);
}

.popup-enter-from,
.popup-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}
</style>
