import React, { useEffect, useState } from 'react'
import { useAuthStore } from './stores/authStore'
import { useServerStore } from './stores/serverStore'
import { useMessageStore } from './stores/messageStore'
import { usePresenceStore } from './stores/presenceStore'
import { useDmChannelStore } from './stores/dmChannelStore'
import { useModerationStore } from './stores/moderationStore'
import { wsManager } from './services/websocket'
import { initCryptoPort } from './services/crypto'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { ServerPage } from './pages/ServerPage'
import type {
  ReadyEvent, MessageCreateEvent, PresenceUpdateEvent,
  ChannelCreateEvent, ChannelUpdateEvent, ChannelDeleteEvent,
  MemberAddEvent, MemberRemoveEvent, SenderKeyDistributionEvent,
  ServerErrorEvent, UserBannedEvent, UserKickedEvent,
  UserMutedEvent, UserUnmutedEvent, ReportCreatedEvent, AbuseSignalEvent,
} from './types/ws'
import { cryptoService } from './services/crypto'

type AuthView = 'login' | 'register'

export function App(): React.ReactElement {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const [authView, setAuthView] = useState<AuthView>('login')

  // Initialize crypto port and hydrate auth state on mount
  useEffect(() => {
    initCryptoPort()
    useAuthStore.getState().hydrateFromStorage()
  }, [])

  // Wire WebSocket events to stores
  useEffect(() => {
    const unsubReady = wsManager.on('READY', (data: ReadyEvent) => {
      useServerStore.getState().setServers(data.servers)
      useServerStore.getState().setChannels(data.channels)

      // Populate DM channels
      if (data.dm_channels) {
        useDmChannelStore.getState().setDmChannels(data.dm_channels)
      }

      // Auto-select first server if none selected
      if (!useServerStore.getState().activeServerId && data.servers.length > 0) {
        useServerStore.getState().setActiveServer(data.servers[0].id)
      }

      // Sync offline SenderKey distributions (fire and forget)
      useMessageStore.getState().syncPendingSenderKeys()

      // Load blocked users on startup
      useModerationStore.getState().loadBlockedUsers()
    })

    const unsubMessage = wsManager.on('MESSAGE_CREATE', (data: MessageCreateEvent) => {
      // Skip messages from blocked users (client-side filter)
      const blockedUserIds = useModerationStore.getState().blockedUserIds
      if (blockedUserIds.has(data.sender_id)) return

      useMessageStore.getState().handleMessageCreate(data)
    })

    const unsubPresence = wsManager.on('PRESENCE_UPDATE', (data: PresenceUpdateEvent) => {
      // Skip presence updates from blocked users
      const blockedUserIds = useModerationStore.getState().blockedUserIds
      if (blockedUserIds.has(data.user_id)) return

      usePresenceStore.getState().updatePresence(data.user_id, data.status)
    })

    const unsubChannelCreate = wsManager.on('CHANNEL_CREATE', (data: ChannelCreateEvent) => {
      useServerStore.getState().addChannel(data)
    })

    const unsubChannelUpdate = wsManager.on('CHANNEL_UPDATE', (data: ChannelUpdateEvent) => {
      useServerStore.getState().updateChannel(data)
    })

    const unsubChannelDelete = wsManager.on('CHANNEL_DELETE', (data: ChannelDeleteEvent) => {
      useServerStore.getState().removeChannel(data.id)
    })

    const unsubMemberAdd = wsManager.on('MEMBER_ADD', (data: MemberAddEvent) => {
      useServerStore.getState().addMember(data.server_id, data.user_id)

      // For private channels: distribute our SenderKey to the new member
      const channels = useServerStore.getState().getServerChannels(data.server_id)
      for (const channel of channels) {
        if (channel.encryption_mode === 'private') {
          useMessageStore.getState().distributeSenderKeyToNewMember(channel.id, data.user_id)
          useMessageStore.getState().addSystemMessage(channel.id, `${data.user_id} joined the channel.`)
        }
      }
    })

    const unsubMemberRemove = wsManager.on('MEMBER_REMOVE', (data: MemberRemoveEvent) => {
      useServerStore.getState().removeMember(data.server_id, data.user_id)

      // For private channels: mark SenderKey as stale and increment local epoch
      const channels = useServerStore.getState().getServerChannels(data.server_id)
      for (const channel of channels) {
        if (channel.encryption_mode === 'private') {
          cryptoService.markSenderKeyStale(channel.id)

          // Increment epoch locally so next send uses the correct epoch.
          // The server also increments; a CHANNEL_UPDATE may arrive later and
          // reconcile, but we must not use the stale epoch in the interim.
          const currentEpoch = channel.sender_key_epoch ?? 0
          useServerStore.getState().updateChannel({
            ...channel,
            sender_key_epoch: currentEpoch + 1,
          })

          useMessageStore.getState().addSystemMessage(channel.id, `${data.user_id} was removed from the channel.`)
        }
      }
    })

    const unsubSenderKeyDist = wsManager.on('SENDER_KEY_DISTRIBUTION', (data: SenderKeyDistributionEvent) => {
      useMessageStore.getState().handleSenderKeyDistribution(data)
    })

    const unsubError = wsManager.on('ERROR', (data: ServerErrorEvent) => {
      useMessageStore.getState().handleServerError(data.code, data.message)
    })

    // --- Moderation events ---

    const unsubBanned = wsManager.on('USER_BANNED', (data: UserBannedEvent) => {
      const currentUserId = useAuthStore.getState().user?.id
      if (data.user_id === currentUserId) {
        // Remove the server from UI
        useServerStore.getState().removeServer(data.server_id)
        // The ServerPage will show a notification via its moderationNotice state.
        // We dispatch a custom event that ServerPage listens for.
        window.dispatchEvent(new CustomEvent('mercury:moderation', {
          detail: { type: 'banned', serverName: data.server_name },
        }))
      } else {
        // Another user was banned — remove them from member list
        useServerStore.getState().removeMember(data.server_id, data.user_id)
      }
    })

    const unsubKicked = wsManager.on('USER_KICKED', (data: UserKickedEvent) => {
      const currentUserId = useAuthStore.getState().user?.id
      if (data.user_id === currentUserId) {
        useServerStore.getState().removeServer(data.server_id)
        window.dispatchEvent(new CustomEvent('mercury:moderation', {
          detail: { type: 'kicked', serverName: data.server_name },
        }))
      } else {
        useServerStore.getState().removeMember(data.server_id, data.user_id)
      }
    })

    const unsubMuted = wsManager.on('USER_MUTED', (data: UserMutedEvent) => {
      const currentUserId = useAuthStore.getState().user?.id
      if (data.user_id === currentUserId) {
        useModerationStore.setState((state) => {
          const mutedChannels = new Set(state.mutedChannels)
          mutedChannels.add(data.channel_id)
          return { mutedChannels }
        })
      }
    })

    const unsubUnmuted = wsManager.on('USER_UNMUTED', (data: UserUnmutedEvent) => {
      const currentUserId = useAuthStore.getState().user?.id
      if (data.user_id === currentUserId) {
        useModerationStore.setState((state) => {
          const mutedChannels = new Set(state.mutedChannels)
          mutedChannels.delete(data.channel_id)
          return { mutedChannels }
        })
      }
    })

    const unsubReportCreated = wsManager.on('REPORT_CREATED', (_data: ReportCreatedEvent) => {
      useModerationStore.getState().incrementReportCount()
    })

    const unsubAbuseSignal = wsManager.on('ABUSE_SIGNAL', (_data: AbuseSignalEvent) => {
      useModerationStore.getState().incrementAbuseSignalCount()
    })

    return () => {
      unsubReady()
      unsubMessage()
      unsubPresence()
      unsubChannelCreate()
      unsubChannelUpdate()
      unsubChannelDelete()
      unsubMemberAdd()
      unsubMemberRemove()
      unsubSenderKeyDist()
      unsubError()
      unsubBanned()
      unsubKicked()
      unsubMuted()
      unsubUnmuted()
      unsubReportCreated()
      unsubAbuseSignal()
    }
  }, [])

  if (!isAuthenticated) {
    if (authView === 'register') {
      return <RegisterPage onSwitchToLogin={() => setAuthView('login')} />
    }
    return <LoginPage onSwitchToRegister={() => setAuthView('register')} />
  }

  return <ServerPage />
}
