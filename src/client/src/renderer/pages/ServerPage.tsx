import React, { useEffect, useCallback, useState, useMemo } from 'react'
import { useServerStore } from '../stores/serverStore'
import { useMessageStore, setIdentityWarningCallback } from '../stores/messageStore'
import { useCallStore } from '../stores/callStore'
import { useModerationStore } from '../stores/moderationStore'
import type { Message } from '../types/models'
import { useDmChannelStore } from '../stores/dmChannelStore'
import { Sidebar } from '../components/layout/Sidebar'
import { ChannelList } from '../components/layout/ChannelList'
import { DmList } from '../components/dm/DmList'
import { EncryptionBadge } from '../components/dm/EncryptionBadge'
import { IdentityWarningDialog } from '../components/dm/IdentityWarningDialog'
import { MessageList } from '../components/chat/MessageList'
import { MessageInput } from '../components/chat/MessageInput'
import { VideoGrid } from '../components/voice/VideoGrid'
import { DiagnosticPanel } from '../components/voice/DiagnosticPanel'
import { VoicePanel } from '../components/voice/VoicePanel'
import { BlockConfirmDialog } from '../components/moderation/BlockConfirmDialog'
import { ReportDialog } from '../components/moderation/ReportDialog'
import { ModerationDashboard } from '../components/moderation/ModerationDashboard'
import { wsManager } from '../services/websocket'

interface ServerPageProps {
  onChangeServer: () => void
}

export function ServerPage({ onChangeServer }: ServerPageProps): React.ReactElement {
  const activeServerId = useServerStore((s) => s.activeServerId)
  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const channels = useServerStore((s) => s.channels)
  const messagesMap = useMessageStore((s) => s.messages)
  const fetchHistory = useMessageStore((s) => s.fetchHistory)
  const fetchDmHistory = useMessageStore((s) => s.fetchDmHistory)
  const fetchPrivateChannelHistory = useMessageStore((s) => s.fetchPrivateChannelHistory)
  const sendMessage = useMessageStore((s) => s.sendMessage)
  const connectionState = useWsConnectionState()

  const viewMode = useDmChannelStore((s) => s.viewMode)
  const activeDmChannelId = useDmChannelStore((s) => s.activeDmChannelId)
  const dmChannels = useDmChannelStore((s) => s.dmChannels)

  const blockedUserIds = useModerationStore((s) => s.blockedUserIds)

  const activeDmChannel = activeDmChannelId ? dmChannels.get(activeDmChannelId) : null
  const activeChannel = activeChannelId ? channels.get(activeChannelId) : null

  const isDmView = viewMode === 'dm'
  const activeId = isDmView ? activeDmChannelId : activeChannelId
  const rawMessages = activeId ? messagesMap.get(activeId) ?? [] : []

  // Filter out messages from blocked users (client-side hide)
  const messages = useMemo(() => {
    if (blockedUserIds.size === 0) return rawMessages
    return rawMessages.filter((m) => !blockedUserIds.has(m.sender_id))
  }, [rawMessages, blockedUserIds])

  // Identity warning state
  const [identityWarning, setIdentityWarning] = useState<{
    recipientName: string
    resolve: (approved: boolean) => void
  } | null>(null)

  // Moderation dialog state
  const [blockTarget, setBlockTarget] = useState<{ userId: string; username: string } | null>(null)
  const [reportTarget, setReportTarget] = useState<Message | null>(null)

  // Ban/kick notification state
  const [moderationNotice, setModerationNotice] = useState<{
    type: 'banned' | 'kicked'
    serverName: string
  } | null>(null)

  // Moderation dashboard state
  const [showModerationDashboard, setShowModerationDashboard] = useState(false)
  const servers = useServerStore((s) => s.servers)
  const activeServer = activeServerId ? servers.get(activeServerId) : null

  // Listen for moderation events (ban/kick)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { type: 'banned' | 'kicked'; serverName: string }
      setModerationNotice(detail)
    }
    window.addEventListener('mercury:moderation', handler)
    return () => window.removeEventListener('mercury:moderation', handler)
  }, [])

  // Set up identity warning callback
  useEffect(() => {
    setIdentityWarningCallback(async (userId, _previousKey, _newKey) => {
      const dm = Array.from(dmChannels.values()).find((ch) => ch.recipient.id === userId)
      const name = dm?.recipient.display_name || dm?.recipient.username || userId
      return new Promise<boolean>((resolve) => {
        setIdentityWarning({ recipientName: name, resolve })
      })
    })
  }, [dmChannels])

  // Close dashboard when switching servers or entering DM view
  useEffect(() => {
    setShowModerationDashboard(false)
  }, [activeServerId, isDmView])

  // Fetch message history when channel changes
  useEffect(() => {
    if (isDmView && activeDmChannelId) {
      fetchDmHistory(activeDmChannelId)
    } else if (!isDmView && activeChannelId) {
      if (activeChannel?.encryption_mode === 'private') {
        fetchPrivateChannelHistory(activeChannelId)
      } else {
        fetchHistory(activeChannelId)
      }
    }
  }, [isDmView, activeDmChannelId, activeChannelId, activeChannel?.encryption_mode, fetchHistory, fetchDmHistory, fetchPrivateChannelHistory])

  const handleLoadMore = useCallback(() => {
    if (!activeId || messages.length === 0) return
    const oldest = messages[0]
    if (oldest && !isDmView) {
      fetchHistory(activeId, oldest.id)
    }
  }, [activeId, messages, fetchHistory, isDmView])

  const handleSend = useCallback(
    (content: string) => {
      if (activeId) {
        sendMessage(activeId, content)
      }
    },
    [activeId, sendMessage]
  )

  const handleReport = useCallback((message: Message) => {
    setReportTarget(message)
  }, [])

  const handleBlock = useCallback((userId: string, username: string) => {
    setBlockTarget({ userId, username })
  }, [])

  // Check if video grid should be shown
  const activeCall = useCallStore((s) => s.activeCall)
  const isCameraOn = useCallStore((s) => s.isCameraOn)
  const participants = useCallStore((s) => s.participants)
  const diagnosticState = useCallStore((s) => s.diagnosticState)

  const hasAnyVideo = useMemo(() => {
    if (isCameraOn) return true
    for (const p of participants.values()) {
      if (p.hasVideo) return true
    }
    return false
  }, [isCameraOn, participants])

  const headerName = isDmView
    ? activeDmChannel?.recipient.display_name || activeDmChannel?.recipient.username
    : activeChannel?.name

  return (
    <div className="flex h-screen">
      {/* Server sidebar (left icons) */}
      <Sidebar />

      {/* Channel/DM list (middle) + persistent VoicePanel */}
      <div className="flex h-full w-60 flex-col">
        <div className="flex-1 overflow-hidden">
          {isDmView ? <DmList /> : <ChannelList onOpenDashboard={() => setShowModerationDashboard(true)} onChangeServer={onChangeServer} />}
        </div>
        <VoicePanel />
      </div>

      {/* Moderation dashboard or Chat area (right) */}
      {showModerationDashboard && activeServerId && activeServer ? (
        <div className="flex flex-1 flex-col">
          <ModerationDashboard
            serverId={activeServerId}
            serverName={activeServer.name}
            onClose={() => setShowModerationDashboard(false)}
          />
        </div>
      ) : (
      <div className="flex flex-1 flex-col bg-bg-tertiary">
        {/* Channel header */}
        <div className="flex h-12 items-center border-b border-border-subtle px-4">
          {headerName ? (
            <div className="flex items-center gap-2">
              {isDmView ? (
                <span className="text-text-muted">@</span>
              ) : (
                <span className="text-text-muted">#</span>
              )}
              <span className="font-semibold text-text-primary">{headerName}</span>
              {isDmView && <EncryptionBadge mode="e2e_dm" />}
              {!isDmView && activeChannel?.encryption_mode === 'private' && <EncryptionBadge mode="private" />}
            </div>
          ) : (
            <span className="text-text-muted">
              {isDmView ? 'Select a conversation' : 'Select a channel'}
            </span>
          )}

          {/* Connection state indicator */}
          {connectionState !== 'CONNECTED' && (
            <span className="ml-auto text-xs text-status-idle">
              {connectionState === 'CONNECTING'
                ? 'Connecting...'
                : connectionState === 'RECONNECTING'
                  ? 'Reconnecting...'
                  : 'Disconnected'}
            </span>
          )}
        </div>

        {/* Diagnostic panel (shown on WebRTC connection failure) */}
        {diagnosticState?.failed && <DiagnosticPanel />}

        {/* Video grid (shown when any participant has video) */}
        {activeCall && hasAnyVideo && <VideoGrid />}

        {/* Message area */}
        {(isDmView ? activeDmChannel : activeChannel) ? (
          <>
            <MessageList
              messages={messages}
              onLoadMore={handleLoadMore}
              onReport={handleReport}
              onBlock={handleBlock}
            />
            <MessageInput
              channelName={headerName || ''}
              onSend={handleSend}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-text-muted">
            {isDmView
              ? 'Select a conversation or start a new one'
              : useServerStore.getState().activeServerId
                ? 'Select a channel to start chatting'
                : 'Select a server from the sidebar'}
          </div>
        )}
      </div>
      )}

      {/* Identity warning dialog */}
      {identityWarning && (
        <IdentityWarningDialog
          recipientName={identityWarning.recipientName}
          onApprove={() => {
            identityWarning.resolve(true)
            setIdentityWarning(null)
          }}
          onCancel={() => {
            identityWarning.resolve(false)
            setIdentityWarning(null)
          }}
        />
      )}

      {/* Block confirmation dialog */}
      {blockTarget && (
        <BlockConfirmDialog
          userId={blockTarget.userId}
          username={blockTarget.username}
          onClose={() => setBlockTarget(null)}
        />
      )}

      {/* Report dialog */}
      {reportTarget && (
        <ReportDialog
          messageId={reportTarget.id}
          senderId={reportTarget.sender_id}
          senderUsername={reportTarget.sender_username || reportTarget.sender_id.slice(0, 8)}
          channelId={reportTarget.channel_id || reportTarget.dm_channel_id || ''}
          serverId={activeServerId || undefined}
          messageContent={reportTarget.content}
          onClose={() => setReportTarget(null)}
        />
      )}

      {/* Ban/kick notification modal */}
      {moderationNotice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-96 rounded-lg bg-bg-secondary p-6 text-center">
            <p className="text-lg font-medium text-text-primary">
              You have been {moderationNotice.type === 'banned' ? 'banned from' : 'kicked from'}{' '}
              {moderationNotice.serverName}
            </p>
            <button
              className="mt-4 rounded bg-bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
              onClick={() => setModerationNotice(null)}
            >
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Hook to track WebSocket connection state
function useWsConnectionState() {
  const [state, setState] = React.useState(wsManager.getState())

  useEffect(() => {
    const unsub = wsManager.onStateChange(setState)
    return unsub
  }, [])

  return state
}
