import React, { useState } from 'react'
import { useServerStore } from '../../stores/serverStore'
import { useAuthStore } from '../../stores/authStore'
import { useModerationStore } from '../../stores/moderationStore'
import { CreateChannelModal } from '../channel/CreateChannelModal'
import { ChannelLockIcon } from '../dm/EncryptionBadge'
import { VoiceChannelEntry } from '../voice/VoiceChannelEntry'
import { getConfiguredServerUrl } from '../../services/serverUrl'

interface ChannelListProps {
  onOpenDashboard?: () => void
  onChangeServer?: () => void
}

export function ChannelList({ onOpenDashboard, onChangeServer }: ChannelListProps): React.ReactElement {
  const activeServerId = useServerStore((s) => s.activeServerId)
  const activeChannelId = useServerStore((s) => s.activeChannelId)
  const setActiveChannel = useServerStore((s) => s.setActiveChannel)
  const servers = useServerStore((s) => s.servers)
  const members = useServerStore((s) => s.members)
  const getServerChannels = useServerStore((s) => s.getServerChannels)
  const user = useAuthStore((s) => s.user)
  const pendingReportCount = useModerationStore((s) => s.pendingReportCount)
  const pendingAbuseSignalCount = useModerationStore((s) => s.pendingAbuseSignalCount)
  const [showCreateChannel, setShowCreateChannel] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const logout = useAuthStore((s) => s.logout)

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
  const memberList = members.get(activeServerId) || []
  const currentMember = memberList.find((m) => m.user_id === user?.id)
  const isModerator = currentMember?.is_moderator === true
  const canModerate = isOwner || isModerator
  const totalModBadge = pendingReportCount + pendingAbuseSignalCount
  const textChannels = channels.filter((c) => c.channel_type === 'text')
  const voiceChannels = channels.filter((c) => c.channel_type === 'voice' || c.channel_type === 'video')

  return (
    <>
      <div className="flex h-full flex-col bg-bg-secondary">
        {/* Server header */}
        <div className="flex h-12 items-center justify-between border-b border-border-subtle px-4">
          <span className="truncate font-semibold text-text-primary">{server?.name}</span>
          {canModerate && onOpenDashboard && (
            <button
              onClick={onOpenDashboard}
              className="relative rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
              title="Moderation Dashboard"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path fillRule="evenodd" d="M9.661 2.237a.531.531 0 0 1 .678 0 11.947 11.947 0 0 0 7.078 2.749.5.5 0 0 1 .479.425c.069.52.104 1.05.104 1.59 0 5.162-3.26 9.563-7.834 11.256a.48.48 0 0 1-.332 0C5.26 16.564 2 12.163 2 7c0-.54.035-1.07.104-1.59a.5.5 0 0 1 .48-.425 11.947 11.947 0 0 0 7.077-2.749Z" clipRule="evenodd" />
              </svg>
              {totalModBadge > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-bg-danger px-1 text-[10px] font-medium text-white">
                  {totalModBadge}
                </span>
              )}
            </button>
          )}
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

        {/* Settings panel (slides up from user area) */}
        {showSettings && (
          <div className="border-t border-border-subtle bg-bg-primary/80 px-3 py-3">
            <div className="mb-2 text-xs font-bold uppercase text-text-muted">Server</div>
            <div className="mb-3 truncate text-sm text-text-secondary" title={getConfiguredServerUrl()}>
              {getConfiguredServerUrl()}
            </div>

            <button
              onClick={onChangeServer}
              className="mb-2 w-full rounded bg-bg-hover px-3 py-1.5 text-left text-sm text-text-secondary hover:bg-bg-active hover:text-text-primary"
            >
              Change server
            </button>
            <button
              onClick={() => logout()}
              className="w-full rounded px-3 py-1.5 text-left text-sm text-red-400 hover:bg-bg-active"
            >
              Log out
            </button>
          </div>
        )}

        {/* User area */}
        <div className="flex items-center gap-2 border-t border-border-subtle bg-bg-primary/50 px-2 py-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-bg-accent text-xs font-semibold text-white">
            {user?.display_name?.charAt(0).toUpperCase() || '?'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-text-primary">{user?.display_name}</div>
            <div className="truncate text-xs text-text-muted">Online</div>
          </div>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
            title="Settings"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path fillRule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      </div>

      {showCreateChannel && activeServerId && (
        <CreateChannelModal serverId={activeServerId} onClose={() => setShowCreateChannel(false)} />
      )}
    </>
  )
}
