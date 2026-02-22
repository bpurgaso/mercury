import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the api module
vi.mock('../../../src/renderer/services/api', () => ({
  dm: {
    create: vi.fn(),
    list: vi.fn(),
    getHistory: vi.fn(),
  },
  setTokenProvider: vi.fn(),
}))

import { useDmChannelStore } from '../../../src/renderer/stores/dmChannelStore'
import type { DmChannel } from '../../../src/renderer/types/models'

const makeDmChannel = (id: string, recipientId: string, username: string): DmChannel => ({
  id,
  recipient: {
    id: recipientId,
    username,
    display_name: username,
    avatar_url: null,
  },
  created_at: new Date().toISOString(),
})

describe('dmChannelStore', () => {
  beforeEach(() => {
    useDmChannelStore.setState({
      dmChannels: new Map(),
      activeDmChannelId: null,
      viewMode: 'server',
    })
    vi.clearAllMocks()
  })

  it('setDmChannels populates the map', () => {
    const channels = [
      makeDmChannel('dm-1', 'user-a', 'Alice'),
      makeDmChannel('dm-2', 'user-b', 'Bob'),
    ]
    useDmChannelStore.getState().setDmChannels(channels)

    const state = useDmChannelStore.getState()
    expect(state.dmChannels.size).toBe(2)
    expect(state.dmChannels.get('dm-1')?.recipient.username).toBe('Alice')
    expect(state.dmChannels.get('dm-2')?.recipient.username).toBe('Bob')
  })

  it('addDmChannel adds a single channel', () => {
    useDmChannelStore.getState().addDmChannel(makeDmChannel('dm-1', 'user-a', 'Alice'))
    expect(useDmChannelStore.getState().dmChannels.size).toBe(1)

    useDmChannelStore.getState().addDmChannel(makeDmChannel('dm-2', 'user-b', 'Bob'))
    expect(useDmChannelStore.getState().dmChannels.size).toBe(2)
  })

  it('setActiveDmChannel sets active and switches to dm viewMode', () => {
    useDmChannelStore.getState().setActiveDmChannel('dm-1')

    const state = useDmChannelStore.getState()
    expect(state.activeDmChannelId).toBe('dm-1')
    expect(state.viewMode).toBe('dm')
  })

  it('setActiveDmChannel(null) switches back to server viewMode', () => {
    useDmChannelStore.getState().setActiveDmChannel('dm-1')
    useDmChannelStore.getState().setActiveDmChannel(null)

    const state = useDmChannelStore.getState()
    expect(state.activeDmChannelId).toBeNull()
    expect(state.viewMode).toBe('server')
  })

  it('setViewMode to server clears activeDmChannelId', () => {
    useDmChannelStore.getState().setActiveDmChannel('dm-1')
    useDmChannelStore.getState().setViewMode('server')

    const state = useDmChannelStore.getState()
    expect(state.activeDmChannelId).toBeNull()
    expect(state.viewMode).toBe('server')
  })

  it('getDmChannelByRecipient finds channel by recipient ID', () => {
    useDmChannelStore.getState().setDmChannels([
      makeDmChannel('dm-1', 'user-a', 'Alice'),
      makeDmChannel('dm-2', 'user-b', 'Bob'),
    ])

    const found = useDmChannelStore.getState().getDmChannelByRecipient('user-b')
    expect(found?.id).toBe('dm-2')
    expect(found?.recipient.username).toBe('Bob')
  })

  it('getDmChannelByRecipient returns undefined for unknown recipient', () => {
    const found = useDmChannelStore.getState().getDmChannelByRecipient('unknown')
    expect(found).toBeUndefined()
  })
})
