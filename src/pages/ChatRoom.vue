<script setup lang="ts">
defineOptions({ name: 'ChatRoomPage' })
import { ref, onMounted, nextTick, watch, computed } from 'vue'
import { useRoom } from '../composables/useRoom'
import { useRoomFiles } from '../composables/useRoomFiles'
import { bindTransfers } from '../composables/useFileTransferProgress'
import { blobs } from '@/core/net/blobs'
import { useNotification } from '../composables/useNotification'
import { useNotificationSound } from '../composables/useNotificationSound'
import { useProfilePicture } from '../composables/useProfilePicture'
import { useBackgroundImage } from '../composables/useBackgroundImage'
import { useStyleSettings } from '../composables/useStyleSettings'
import { showAlert, showConfirm } from '../composables/useCustomDialog'
import { useConnectedUsers } from '../composables/useConnectedUsers'
import router from '@/router'
import ChatHeader from '@/components/layout/ChatHeader.vue'
import MessageList from '@/components/message/MessageList.vue'
import ChatInput from '@/components/message/ChatInput.vue'
import TransferPanel from '@/components/transfer/TransferPanel.vue'
import ProfilePictureUpload from '@/components/profile/ProfilePictureUpload.vue'
import ImageModal from '@/components/image/ImageModal.vue'
import FileTransferProgress from '@/components/file/FileTransferProgress.vue'

const RECENT_MESSAGES_TO_LOAD = 30

const props = defineProps<{
  roomId?: string
  name?: string
}>()

// Identity & Room Setup
if (!localStorage.getItem('uuid')) {
  localStorage.setItem('uuid', crypto.randomUUID())
}

const uuid = localStorage.getItem('uuid')!
const me = `user-${uuid}`

// 닉네임 설정: props.name > localStorage > 기본값(User+uuid)
const storedName = localStorage.getItem('name')
const nameToUse = props.name?.trim() || storedName?.trim() || ''
const myName = ref(nameToUse ? `${nameToUse}${me.slice(-4)}` : `User ${me.slice(-4)}`)

// localStorage에 닉네임 저장 (props로 전달된 경우)
if (props.name && (!storedName || storedName !== props.name)) {
  localStorage.setItem('name', props.name)
}

const activeRoomId = props.roomId?.trim() || 'default-room'

// 로컬 기록은 바로 쓸 수 있고, 네트워크가 없으면 나중에 동기화된다.
const yjsReady = ref(true)
const isUploading = ref(false)
const isInitialLoad = ref(true)
const isSendingMessage = ref(false) // 내가 메시지를 보내는 중인지 추적

// Room(P2P 동기화) & 파일
const room = await useRoom(activeRoomId, me, myName.value)
const { messagesRef, messagesMap, files, sendTextMessage, attachFileMeta, provider, transfers, net, loadMoreMessages, resetToLatest, isViewingLatest, forceResync, importSnapshot, exportSnapshot } = room
bindTransfers(transfers.transfers, id => files.get(id)?.name)

const { imageUrls, loadingImages, failedDownloads, prepareFile, ensureFile, downloadImage, processAutoDownload, downloadFile } = useRoomFiles(room)
const { showNotification } = useNotification()

// 알림 소리
const { playSound } = useNotificationSound()

// 프로필 사진 기능
const {
  myProfilePicture,
  getUserProfilePicture,
  initializeProfilePictures,
  getProfileOriginalFileId,
  createProfileHandlers
} = useProfilePicture(room, me)

// 공통 핸들러 생성 (캡슐화)
const { handleUpload: handleProfileUpload, handleDelete: handleProfileDelete } = createProfileHandlers()

// 접속자 목록 기능
const { connectedUsers, userCount } = useConnectedUsers(provider, me)

// 배경 이미지
const { currentBackground, isElectron } = useBackgroundImage('chat')

// 스타일 설정 (실시간 CSS 변수 업데이트)
useStyleSettings()

const backgroundStyle = computed(() => {
  if (currentBackground.value) {
    return {
      backgroundImage: `url(${currentBackground.value})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat'
    }
  }
  return {}
})

const messageListRef = ref<InstanceType<typeof MessageList> | null>(null)
const showProfileModal = ref(false)
const showProfileImageModal = ref(false)
const viewingProfileUserId = ref<string | null>(null)
const viewingProfileImageUrl = ref<string | null>(null)
const viewingProfileFileId = ref<string | null>(null)
const downloadingProfileFileId = ref<string | null>(null)
const isDraggingOver = ref(false)

// Watch Party - Electron에서 별도 창으로 열기
const handleOpenWatchParty = () => {
  if (window.electronApi?.openWatchParty) {
    // 채팅방의 이름만 전달 (localStorage의 순수 닉네임)
    const pureName = localStorage.getItem('name') || ''
    console.log('[ChatRoom] Opening WatchParty with:', {
      roomId: activeRoomId,
      name: pureName
    })
    window.electronApi.openWatchParty(activeRoomId, undefined, pureName)
  }
}

// 드래그 앤 드롭 핸들러
const handleDragOver = (e: DragEvent) => {
  e.preventDefault()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy'
  }
  isDraggingOver.value = true
}

const handleDragLeave = (e: DragEvent) => {
  e.preventDefault()
  isDraggingOver.value = false
}

const handleDrop = async (e: DragEvent) => {
  e.preventDefault()
  isDraggingOver.value = false

  if (!yjsReady.value || isUploading.value) {
    await showAlert('현재 파일을 업로드할 수 없습니다.')
    return
  }

  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return

  // 첫 번째 파일만 업로드
  const file = files[0]
  if (file) {
    await handleUploadFile(file)
  }
}

// Handlers
const handleSend = (message: string) => {
  if (yjsReady.value) {
    // 메시지 전송 시작 플래그 설정 (watch에서 알림이 울리지 않도록)
    isSendingMessage.value = true
    sendTextMessage(me, myName.value, message)
    // 본인이 메시지를 보낼 때는 항상 최신 메시지로 이동
    resetToLatest()
    nextTick(() => {
      messageListRef.value?.scrollToBottom()
      // 스크롤 완료 후 플래그 해제 (약간의 지연을 두어 watch 트리거가 완료되도록)
      setTimeout(() => {
        isSendingMessage.value = false
      }, 150)
    })
  }
}

const handleUploadFile = async (file: File) => {
  if (!yjsReady.value || isUploading.value) return

  try {
    isUploading.value = true
    // 파일 전송 시작 플래그 설정 (watch에서 알림이 울리지 않도록)
    isSendingMessage.value = true
    console.log('파일 업로드:', file.name, file.type)
    const { fileId, meta } = await prepareFile(file)
    attachFileMeta(fileId, meta, me, myName.value)

    // 본인이 파일을 보낼 때는 항상 최신 메시지로 이동
    resetToLatest()
    await nextTick()
    messageListRef.value?.scrollToBottom()

    // 스크롤 완료 후 플래그 해제
    setTimeout(() => {
      isSendingMessage.value = false
    }, 150)

    console.log('업로드 완료:', fileId)
  } catch (error) {
    console.error('업로드 실패:', error)
    await showAlert('파일 업로드에 실패했습니다.')
    isSendingMessage.value = false // 에러 발생 시에도 플래그 해제
  } finally {
    isUploading.value = false
  }
}

const handleRequestDownload = (fileId: string) => fileId && downloadImage(fileId, true)
const handleDownload = async (fileId: string) => {
  if (!fileId) return
  try {
    await downloadFile(fileId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== 'cancelled') await showAlert(`파일을 저장하지 못했습니다.
${message}`)
  }
}
const handleLoadMore = () => loadMoreMessages()
const handleResetToLatest = () => resetToLatest()

// 프로필 원본 보기
const handleViewProfile = async (userId: string) => {
  try {
    viewingProfileUserId.value = userId

    // 원본 파일 ID 가져오기
    const originalFileId = await getProfileOriginalFileId(userId)

    if (!originalFileId) {
      await showAlert('원본 프로필 사진이 없습니다.')
      return
    }

    // 없으면 받고(이미 있으면 바로 끝난다), 로컬 파일 URL로 표시한다
    downloadingProfileFileId.value = originalFileId
    await ensureFile(originalFileId)
    downloadingProfileFileId.value = null
    viewingProfileFileId.value = originalFileId
    viewingProfileImageUrl.value = await blobs.url(originalFileId)
    showProfileImageModal.value = true
  } catch (error) {
    console.error('[ChatRoom] 프로필 원본 로드 실패:', error)
    downloadingProfileFileId.value = null

    // 원본 다운로드 실패 시 압축된 썸네일을 대신 표시
    const thumbnailUrl = getUserProfilePicture.value(userId)
    if (thumbnailUrl) {
      viewingProfileFileId.value = null
      viewingProfileImageUrl.value = thumbnailUrl
      showProfileImageModal.value = true
    } else {
      await showAlert('프로필 사진을 불러올 수 없습니다.')
    }
  }
}

const handleCloseProfileImage = () => {
  showProfileImageModal.value = false
  viewingProfileImageUrl.value = null
  viewingProfileFileId.value = null
  viewingProfileUserId.value = null
}

const handleDownloadProfileImage = async () => {
  if (!viewingProfileUserId.value) return
  try {
    if (viewingProfileFileId.value) {
      await blobs.saveAs(viewingProfileFileId.value, `profile_${viewingProfileUserId.value}_original.jpg`)
    }
  } catch (error) {
    console.error('[ChatRoom] 프로필 다운로드 실패:', error)
  }
}
const handleGoHome = () => {
  // Electron 환경에서는 메인 윈도우 표시
  if (window.electronApi) {
    window.electronApi.showMainWindow()
  } else {
    // 웹 환경에서는 라우터로 이동
    router.push({ name: 'Home' })
  }
}

const handleCloseChatRoom = () => {
  // Electron 환경에서만 채팅방을 완전히 닫을 수 있음
  if (window.electronApi) {
    // close()가 아니라 destroy()를 호출해야 완전히 닫힙
    window.electronApi.windowDestroy()
  }
}

// 프로필 사진 핸들러
const handleOpenProfileSettings = () => {
  showProfileModal.value = true
}

const handleCloseProfileSettings = () => {
  showProfileModal.value = false
}

const handleClearChat = () => messagesMap.clear()
const handleReload = () => window.location.reload()

const handleForceResync = async () => {
  const confirmed = await showConfirm('🔄 동기화 오류가 발생했나요?\n\n로컬 데이터를 삭제하고 다른 피어의 데이터로 재동기화합니다.\n\n계속하시겠습니까?')
  if (!confirmed) return

  try {
    const success = await forceResync()
    if (success) {
      await showAlert('✅ 재동기화가 완료되었습니다.')
      window.location.reload()
    } else {
      await showAlert('❌ 재동기화에 실패했습니다.')
    }
  } catch (error) {
    console.error('[ChatRoom] 재동기화 실패:', error)
    await showAlert('❌ 재동기화 중 오류가 발생했습니다.')
  }
}

const handleResetAll = async () => {
  const confirmed = await showConfirm(`⚠️ 경고: "${activeRoomId}" 방의 모든 데이터를 초기화합니다. 계속하시겠습니까?`)
  if (!confirmed) return

  try {
    console.log(`[DEBUG] ${activeRoomId} 방 초기화 시작`)
    provider.disconnect()

    const dbName = `ydb-${activeRoomId}`
    await new Promise<void>((resolve, reject) => {
      const deleteRequest = indexedDB.deleteDatabase(dbName)
      deleteRequest.onsuccess = () => {
        console.log(`[DEBUG] ✅ IndexedDB 삭제: ${dbName}`)
        resolve()
      }
      deleteRequest.onerror = reject
      deleteRequest.onblocked = () => setTimeout(resolve, 1000)
    })

    window.location.reload()
  } catch (error) {
    console.error('[DEBUG] 초기화 실패:', error)
    await showAlert('❌ 초기화 중 오류가 발생했습니다.')
  }
}
// Message watching
let previousTotalMessageCount = 0
let notifiedMessageIds = new Set<string>() // 이미 알림을 보낸 메시지 ID 추적

watch(messagesRef, async (newMessages) => {
  await nextTick()

  // 최신 메시지를 보고 있을 때만 자동 스크롤
  if (isViewingLatest()) {
    messageListRef.value?.scrollToBottom()
  }

  await processAutoDownload(messagesRef.value.slice(-RECENT_MESSAGES_TO_LOAD))

  const currentTotalCount = messagesMap.size // Y.Map의 실제 크기

  // 내가 메시지를 보내는 중이면 알림을 울리지 않음 (중복 알림 방지)
  if (!isInitialLoad.value && currentTotalCount > previousTotalMessageCount && !isSendingMessage.value) {
    const newMessage = newMessages[newMessages.length - 1]
    if (newMessage && newMessage.authorTrueUuid !== me) {
      // 이미 알림을 보낸 메시지인지 확인
      if (notifiedMessageIds.has(newMessage.id)) {
        console.log('[알림] 이미 알림을 보낸 메시지, 스킵:', newMessage.id)
      } else {
        const authorName = newMessage.authorName || 'Unknown'
        const text = newMessage.text || '파일을 전송했습니다'
        console.log('[알림] 새 메시지:', { authorName, text, totalCount: currentTotalCount })
        showNotification(authorName, text, newMessage.id, activeRoomId)
        // 알림 소리 재생
        playSound()
        // 알림을 보낸 메시지 ID 기록
        notifiedMessageIds.add(newMessage.id)
        // Set이 너무 커지지 않도록 오래된 항목 정리 (최근 100개만 유지)
        if (notifiedMessageIds.size > 100) {
          const idsArray = Array.from(notifiedMessageIds)
          notifiedMessageIds = new Set(idsArray.slice(-50))
        }
      }
    }
  }
  previousTotalMessageCount = currentTotalCount
})

// Initialization
onMounted(async () => {
  // 절전/네트워크 변경 뒤에는 연결을 새로 맺는다
  window.electronApi?.onSystemResume?.(() => room.reconnect())

  // 프로필 사진 초기화 (내 것 불러오기 + 상대 프로필 구독)
  await initializeProfilePictures()

  // 초기 메시지 로드 및 스크롤
  await nextTick()

  // 최초 로딩 시 스크롤을 맨 아래로
  messageListRef.value?.scrollToBottom()

  // 이미지 자동 다운로드 시작
  await processAutoDownload(messagesRef.value.slice(-RECENT_MESSAGES_TO_LOAD))

  // 초기 로드 완료 표시 (알림 활성화)
  isInitialLoad.value = false
  console.log('[알림] 초기 로드 완료')
})
const handleExportSnapshot = async () => {
  try {
    const snapshotUint8Array = exportSnapshot()
    const snapshotBlob = new Blob([snapshotUint8Array as BlobPart], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(snapshotBlob)
    const a = document.createElement('a')
    a.href = url
    //date as YYYYMMDDHHMMSS
    a.download = `chatroom_${activeRoomId}_${new Date().toISOString().slice(0, 19).replace(/[-T:]/g, '')}_snapshot.chitchat`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (error) {
    console.error('[ChatRoom] 스냅샷 내보내기 실패:', error)
    await showAlert('❌ 스냅샷 내보내기에 실패했습니다.')
  }
}
const handleImportSnapshot = async () => {
  try {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.chitchat'
    input.onchange = async () => {
      if (input.files && input.files.length > 0) {
        const file = input.files[0]
        if (!file) return

        // File을 Uint8Array로 변환
        const arrayBuffer = await file.arrayBuffer()
        const uint8Array = new Uint8Array(arrayBuffer)

        importSnapshot(uint8Array)
        await showAlert('✅ 스냅샷 가져오기가 완료되었습니다. 페이지를 새로고침합니다.')
        window.location.reload()
      }
    }
    document.body.appendChild(input)
    input.click()
    document.body.removeChild(input)
  } catch (error) {
    console.error('[ChatRoom] 스냅샷 가져오기 실패:', error)
    await showAlert('❌ 스냅샷 가져오기에 실패했습니다.')
  }
}
</script>

<template>
  <div
    class="chat-room"
    :style="backgroundStyle"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- 배경 오버레이 (커스텀 배경이 있을 때) -->
    <div v-if="currentBackground" class="background-overlay"></div>

    <!-- 드래그 앤 드롭 오버레이 -->
    <div v-if="isDraggingOver" class="drop-overlay">
      <div class="drop-message">
        <div class="drop-icon">📎</div>
        <div class="drop-text">파일을 여기에 놓으세요</div>
      </div>
    </div>

    <ChatHeader
      :roomId="activeRoomId"
      :net="net"
      :userCount="userCount"
      :connectedUsers="connectedUsers"
      :isElectron="isElectron"
      @export="handleExportSnapshot"
      @import="handleImportSnapshot"
      @reload="handleReload"
      @forceResync="handleForceResync"
      @goHome="handleGoHome"
      @clearChat="handleClearChat"
      @resetAll="handleResetAll"
      @closeChatRoom="handleCloseChatRoom"
      @openWatchParty="handleOpenWatchParty"
    />

    <MessageList
      ref="messageListRef"
      :messages="messagesRef"
      :files="files"
      :imageUrls="imageUrls"
      :loadingImages="loadingImages"
      :failedDownloads="failedDownloads"
      :isReady="yjsReady"
      :getUserProfilePicture="getUserProfilePicture"
      @download="handleDownload"
      @requestDownload="handleRequestDownload"
      @loadMore="handleLoadMore"
      @resetToLatest="handleResetToLatest"
      @viewProfile="handleViewProfile"
    />

    <ChatInput
      :disabled="!yjsReady"
      :isUploading="isUploading"
      @send="handleSend"
      @uploadFile="handleUploadFile"
      @openProfileSettings="handleOpenProfileSettings"
      :myProfilePicture="myProfilePicture"
      :userName="myName"
    />

    <!-- 프로필 설정 모달 -->
    <div v-if="showProfileModal" class="modal-overlay" @click="handleCloseProfileSettings">
      <div class="modal-content" @click.stop>
        <div class="modal-header">
          <h2>프로필 설정</h2>
          <button class="close-button" @click="handleCloseProfileSettings">✕</button>
        </div>
        <ProfilePictureUpload
          :currentImage="myProfilePicture"
          :disabled="!yjsReady"
          @upload="handleProfileUpload"
          @delete="handleProfileDelete"
        />
      </div>
    </div>

    <!-- 전송 큐 상태 표시 (화면 우측 하단) -->
    <TransferPanel @cancel="transfers.cancel" @retry="transfers.retry" />

    <!-- 프로필 원본 다운로드 진행률 -->
    <FileTransferProgress
      v-if="downloadingProfileFileId"
      :fileId="downloadingProfileFileId"
      fileName="프로필 사진"
    />

    <!-- 프로필 원본 이미지 모달 -->
    <ImageModal
      v-if="showProfileImageModal && viewingProfileImageUrl"
      :imageUrl="viewingProfileImageUrl"
      :fileName="`Profile_${viewingProfileUserId}`"
      @close="handleCloseProfileImage"
      @download="handleDownloadProfileImage"
    />
  </div>
</template>

<style scoped>
.chat-room {
  height: 100%;
  width: 100%;
  padding: var(--spacing-md);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  position: relative;
  background: var(--gradient-primary);
}

.background-overlay {
  position: absolute;
  inset: 0;
  background: rgba(var(--bg-primary-rgb, 255, 255, 255), var(--bg-overlay-opacity-chat, 0.75));
  pointer-events: none;
  z-index: 0;
}

.drop-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(135deg, rgba(156, 124, 181, 0.9) 0%, rgba(212, 165, 201, 0.9) 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
  pointer-events: none;
  backdrop-filter: blur(var(--bg-blur-chat, 4px));
}

.drop-message {
  text-align: center;
  color: var(--text-on-primary);
}

.drop-icon {
  font-size: 64px;
  margin-bottom: var(--spacing-lg);
  filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.2));
}

.drop-text {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-bold);
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--bg-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-modal);
  backdrop-filter: blur(var(--bg-blur-chat, 4px));
}

.modal-content {
  background: var(--bg-primary);
  border-radius: var(--radius-xl);
  padding: var(--spacing-xl);
  max-width: 400px;
  width: 90%;
  box-shadow: var(--shadow-xl);
  border: 1px solid var(--border-light);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-lg);
}

.modal-header h2 {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.close-button {
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  font-size: var(--font-size-lg);
  cursor: pointer;
  color: var(--text-secondary);
  padding: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  transition: all var(--transition-fast);
}

.close-button:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}
</style>
