import React, { useEffect, useState } from 'react'
import { useAuthStore } from './stores/authStore'
import { useServerStore } from './stores/serverStore'
import { useMessageStore } from './stores/messageStore'
import { usePresenceStore } from './stores/presenceStore'
import { useDmChannelStore } from './stores/dmChannelStore'
import { wsManager } from './services/websocket'
import { initCryptoPort } from './services/crypto'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { ServerPage } from './pages/ServerPage'
import type { ReadyEvent, MessageCreateEvent, PresenceUpdateEvent, ChannelCreateEvent, ChannelUpdateEvent, ChannelDeleteEvent, MemberAddEvent, MemberRemoveEvent } from './types/ws'

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
    })

    const unsubMessage = wsManager.on('MESSAGE_CREATE', (data: MessageCreateEvent) => {
      useMessageStore.getState().handleMessageCreate(data)
    })

    const unsubPresence = wsManager.on('PRESENCE_UPDATE', (data: PresenceUpdateEvent) => {
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
    })

    const unsubMemberRemove = wsManager.on('MEMBER_REMOVE', (data: MemberRemoveEvent) => {
      useServerStore.getState().removeMember(data.server_id, data.user_id)
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
