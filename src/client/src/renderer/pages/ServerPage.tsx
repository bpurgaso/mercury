import React, { useEffect, useCallback } from 'react'
import { useServerStore } from '../stores/serverStore'
import { useMessageStore } from '../stores/messageStore'
import { Sidebar } from '../components/layout/Sidebar'
import { ChannelList } from '../components/layout/ChannelList'
import { MessageList } from '../components/chat/MessageList'
import { MessageInput } from '../components/chat/MessageInput'
import { wsManager } from '../services/websocket'

export function ServerPage(): React.ReactElement {
  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const channels = useServerStore((s) => s.channels)
  const messagesMap = useMessageStore((s) => s.messages)
  const fetchHistory = useMessageStore((s) => s.fetchHistory)
  const sendMessage = useMessageStore((s) => s.sendMessage)
  const connectionState = useWsConnectionState()

  const activeChannel = activeChannelId ? channels.get(activeChannelId) : null
  const messages = activeChannelId ? messagesMap.get(activeChannelId) ?? [] : []

  // Fetch message history when channel changes
  useEffect(() => {
    if (activeChannelId) {
      fetchHistory(activeChannelId)
    }
  }, [activeChannelId, fetchHistory])

  const handleLoadMore = useCallback(() => {
    if (!activeChannelId || messages.length === 0) return
    const oldest = messages[0]
    if (oldest) {
      fetchHistory(activeChannelId, oldest.id)
    }
  }, [activeChannelId, messages, fetchHistory])

  const handleSend = useCallback(
    (content: string) => {
      if (activeChannelId) {
        sendMessage(activeChannelId, content)
      }
    },
    [activeChannelId, sendMessage]
  )

  return (
    <div className="flex h-screen">
      {/* Server sidebar (left icons) */}
      <Sidebar />

      {/* Channel list (middle) */}
      <ChannelList />

      {/* Chat area (right) */}
      <div className="flex flex-1 flex-col bg-bg-tertiary">
        {/* Channel header */}
        <div className="flex h-12 items-center border-b border-border-subtle px-4">
          {activeChannel ? (
            <div className="flex items-center gap-2">
              <span className="text-text-muted">#</span>
              <span className="font-semibold text-text-primary">{activeChannel.name}</span>
            </div>
          ) : (
            <span className="text-text-muted">Select a channel</span>
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
        {activeChannel ? (
          <>
            <MessageList messages={messages} onLoadMore={handleLoadMore} />
            <MessageInput channelName={activeChannel.name} onSend={handleSend} />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-text-muted">
            {useServerStore.getState().activeServerId
              ? 'Select a channel to start chatting'
              : 'Select a server from the sidebar'}
          </div>
        )}
      </div>
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
