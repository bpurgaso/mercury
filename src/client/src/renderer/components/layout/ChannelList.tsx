import React, { useState } from 'react'
import { useServerStore } from '../../stores/serverStore'
import { useAuthStore } from '../../stores/authStore'
import { CreateChannelModal } from '../channel/CreateChannelModal'
import { ChannelLockIcon } from '../dm/EncryptionBadge'
import { VoiceChannelEntry } from '../voice/VoiceChannelEntry'

export function ChannelList(): React.ReactElement {
  const activeServerId = useServerStore((s) => s.activeServerId)
  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const setActiveChannel = useServerStore((s) => s.setActiveChannel)
  const servers = useServerStore((s) => s.servers)
  const getServerChannels = useServerStore((s) => s.getServerChannels)
  const user = useAuthStore((s) => s.user)
  const [showCreateChannel, setShowCreateChannel] = useState(false)

  if (!activeServerId) {
    return (
      <div className="flex h-full flex-col bg-bg-secondary">
        <div className="flex h-12 items-center border-b border-border-subtle px-4">
          <span className="text-text-muted">Select a server</span>
        </div>
      </div>
    )
  }

  const server = servers.get(activeServerId)
  const channels = getServerChannels(activeServerId)
  const isOwner = server?.owner_id === user?.id
  const textChannels = channels.filter((c) => c.channel_type === 'text')
  const voiceChannels = channels.filter((c) => c.channel_type === 'voice' || c.channel_type === 'video')

  return (
    <>
      <div className="flex h-full flex-col bg-bg-secondary">
        {/* Server header */}
        <div className="flex h-12 items-center border-b border-border-subtle px-4">
          <span className="truncate font-semibold text-text-primary">{server?.name}</span>
        </div>

        {/* Channel list */}
        <div className="flex-1 overflow-y-auto px-2 pt-4">
          {/* Text Channels */}
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-xs font-bold uppercase text-text-muted">Text Channels</span>
            {isOwner && (
              <button
                onClick={() => setShowCreateChannel(true)}
                className="text-text-muted hover:text-text-primary"
                title="Create Channel"
              >
                +
              </button>
            )}
          </div>

          {textChannels.map((channel) => (
            <button
              key={channel.id}
              onClick={() => setActiveChannel(channel.id)}
              className={`mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
                activeChannelId === channel.id
                  ? 'bg-bg-active text-text-primary'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              <span className="text-text-muted">{channel.encryption_mode === 'private' ? '' : '#'}</span>
              {channel.encryption_mode === 'private' && <ChannelLockIcon />}
              <span className="truncate">{channel.name}</span>
            </button>
          ))}

          {/* Voice Channels */}
          {voiceChannels.length > 0 && (
            <>
              <div className="mb-1 mt-4 flex items-center justify-between px-2">
                <span className="text-xs font-bold uppercase text-text-muted">Voice Channels</span>
              </div>

              {voiceChannels.map((channel) => (
                <VoiceChannelEntry key={channel.id} channel={channel} />
              ))}
            </>
          )}
        </div>

        {/* User area */}
        <div className="flex items-center gap-2 border-t border-border-subtle bg-bg-primary/50 px-2 py-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-bg-accent text-xs font-semibold text-white">
            {user?.display_name?.charAt(0).toUpperCase() || '?'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-text-primary">{user?.display_name}</div>
            <div className="truncate text-xs text-text-muted">Online</div>
          </div>
        </div>
      </div>

      {showCreateChannel && activeServerId && (
        <CreateChannelModal serverId={activeServerId} onClose={() => setShowCreateChannel(false)} />
      )}
    </>
  )
}
