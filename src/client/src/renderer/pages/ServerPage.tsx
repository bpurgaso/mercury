import React, { useEffect, useCallback, useState } from 'react'
import { useServerStore } from '../stores/serverStore'
import { useMessageStore, setIdentityWarningCallback } from '../stores/messageStore'
import { useDmChannelStore } from '../stores/dmChannelStore'
import { Sidebar } from '../components/layout/Sidebar'
import { ChannelList } from '../components/layout/ChannelList'
import { DmList } from '../components/dm/DmList'
import { EncryptionBadge } from '../components/dm/EncryptionBadge'
import { IdentityWarningDialog } from '../components/dm/IdentityWarningDialog'
import { MessageList } from '../components/chat/MessageList'
import { MessageInput } from '../components/chat/MessageInput'
import { wsManager } from '../services/websocket'

export function ServerPage(): React.ReactElement {
  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const channels = useServerStore((s) => s.channels)
  const messagesMap = useMessageStore((s) => s.messages)
  const fetchHistory = useMessageStore((s) => s.fetchHistory)
  const fetchDmHistory = useMessageStore((s) => s.fetchDmHistory)
  const sendMessage = useMessageStore((s) => s.sendMessage)
  const connectionState = useWsConnectionState()

  const viewMode = useDmChannelStore((s) => s.viewMode)
  const activeDmChannelId = useDmChannelStore((s) => s.activeDmChannelId)
  const dmChannels = useDmChannelStore((s) => s.dmChannels)

  const activeDmChannel = activeDmChannelId ? dmChannels.get(activeDmChannelId) : null
  const activeChannel = activeChannelId ? channels.get(activeChannelId) : null

  const isDmView = viewMode === 'dm'
  const activeId = isDmView ? activeDmChannelId : activeChannelId
  const messages = activeId ? messagesMap.get(activeId) ?? [] : []

  // Identity warning state
  const [identityWarning, setIdentityWarning] = useState<{
    recipientName: string
    resolve: (approved: boolean) => void
  } | null>(null)

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

  // Fetch message history when channel changes
  useEffect(() => {
    if (isDmView && activeDmChannelId) {
      fetchDmHistory(activeDmChannelId)
    } else if (!isDmView && activeChannelId) {
      fetchHistory(activeChannelId)
    }
  }, [isDmView, activeDmChannelId, activeChannelId, fetchHistory, fetchDmHistory])

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

  const headerName = isDmView
    ? activeDmChannel?.recipient.display_name || activeDmChannel?.recipient.username
    : activeChannel?.name

  return (
    <div className="flex h-screen">
      {/* Server sidebar (left icons) */}
      <Sidebar />

      {/* Channel/DM list (middle) */}
      {isDmView ? <DmList /> : <ChannelList />}

      {/* Chat area (right) */}
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
              {isDmView && <EncryptionBadge />}
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

        {/* Message area */}
        {(isDmView ? activeDmChannel : activeChannel) ? (
          <>
            <MessageList messages={messages} onLoadMore={handleLoadMore} />
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
