import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the api module
vi.mock('../../../src/renderer/services/api', () => ({
  servers: {
    create: vi.fn(),
    list: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
  },
  channels: {
    create: vi.fn(),
    list: vi.fn(),
  },
  setTokenProvider: vi.fn(),
}))

vi.mock('../../../src/renderer/services/websocket', () => ({
  wsManager: { connect: vi.fn(), disconnect: vi.fn() },
}))

import { useServerStore } from '../../../src/renderer/stores/serverStore'
import { servers as serversApi, channels as channelsApi } from '../../../src/renderer/services/api'
import type { Server, Channel } from '../../../src/renderer/types/models'

const makeServer = (id: string, name: string): Server => ({
  id,
  name,
  description: null,
  icon_url: null,
  owner_id: 'owner-1',
  invite_code: 'ABC12345',
  max_members: null,
  created_at: null,
})

const makeChannel = (id: string, serverId: string, name: string): Channel => ({
  id,
  server_id: serverId,
  name,
  channel_type: 'text',
  encryption_mode: 'standard',
  position: 0,
  topic: null,
  created_at: null,
})

describe('serverStore', () => {
  beforeEach(() => {
    useServerStore.setState({
      servers: new Map(),
      channels: new Map(),
      members: new Map(),
      activeServerId: null,
      activeChannelId: null,
    })
    vi.clearAllMocks()
  })

  // TESTSPEC: ST-004
  it('setServers populates the server map', () => {
    const s1 = makeServer('s1', 'Server 1')
    const s2 = makeServer('s2', 'Server 2')

    useServerStore.getState().setServers([s1, s2])

    expect(useServerStore.getState().servers.size).toBe(2)
    expect(useServerStore.getState().servers.get('s1')?.name).toBe('Server 1')
  })

  it('addServer adds to the map', () => {
    useServerStore.getState().addServer(makeServer('s1', 'Test'))

    expect(useServerStore.getState().servers.size).toBe(1)
    expect(useServerStore.getState().servers.has('s1')).toBe(true)
  })

  it('removeServer removes server and its channels', () => {
    useServerStore.getState().addServer(makeServer('s1', 'Test'))
    useServerStore.getState().addChannel(makeChannel('c1', 's1', 'general'))
    useServerStore.getState().addChannel(makeChannel('c2', 's1', 'random'))

    expect(useServerStore.getState().channels.size).toBe(2)

    useServerStore.getState().removeServer('s1')

    expect(useServerStore.getState().servers.size).toBe(0)
    expect(useServerStore.getState().channels.size).toBe(0)
  })

  // TESTSPEC: ST-005
  it('createServer calls API and adds to store', async () => {
    const server = makeServer('s1', 'New Server')
    vi.mocked(serversApi.create).mockResolvedValue(server)

    const result = await useServerStore.getState().createServer('New Server')

    expect(result.id).toBe('s1')
    expect(useServerStore.getState().servers.has('s1')).toBe(true)
    expect(serversApi.create).toHaveBeenCalledWith({ name: 'New Server' })
  })

  // TESTSPEC: ST-006
  it('joinServer calls API, adds to store, and fetches channels', async () => {
    const server = makeServer('s2', 'Joined Server')
    const channels = [makeChannel('c1', 's2', 'general'), makeChannel('c2', 's2', 'random')]
    vi.mocked(serversApi.join).mockResolvedValue(server)
    vi.mocked(channelsApi.list).mockResolvedValue(channels)

    const result = await useServerStore.getState().joinServer('INVITE01')

    expect(result.id).toBe('s2')
    expect(useServerStore.getState().servers.has('s2')).toBe(true)
    expect(channelsApi.list).toHaveBeenCalledWith('s2')
    expect(useServerStore.getState().channels.size).toBe(2)
    expect(useServerStore.getState().channels.has('c1')).toBe(true)
  })

  it('setChannels adds channels to the map', () => {
    const c1 = makeChannel('c1', 's1', 'general')
    const c2 = makeChannel('c2', 's1', 'random')

    useServerStore.getState().setChannels([c1, c2])

    expect(useServerStore.getState().channels.size).toBe(2)
  })

  it('getServerChannels filters and sorts by position', () => {
    useServerStore.getState().addChannel({ ...makeChannel('c1', 's1', 'general'), position: 1 })
    useServerStore.getState().addChannel({ ...makeChannel('c2', 's1', 'random'), position: 0 })
    useServerStore.getState().addChannel(makeChannel('c3', 's2', 'other'))

    const channels = useServerStore.getState().getServerChannels('s1')

    expect(channels.length).toBe(2)
    expect(channels[0].name).toBe('random')
    expect(channels[1].name).toBe('general')
  })

  // TESTSPEC: ST-007
  it('setActiveServer auto-selects first text channel', () => {
    useServerStore.getState().addServer(makeServer('s1', 'Test'))
    useServerStore.getState().addChannel(makeChannel('c1', 's1', 'general'))

    useServerStore.getState().setActiveServer('s1')

    expect(useServerStore.getState().activeServerId).toBe('s1')
    expect(useServerStore.getState().activeChannelId).toBe('c1')
  })

  it('addMember and removeMember update members', () => {
    useServerStore.getState().addMember('s1', 'u1')
    useServerStore.getState().addMember('s1', 'u2')

    expect(useServerStore.getState().members.get('s1')?.length).toBe(2)

    useServerStore.getState().removeMember('s1', 'u1')

    expect(useServerStore.getState().members.get('s1')?.length).toBe(1)
    expect(useServerStore.getState().members.get('s1')?.[0].user_id).toBe('u2')
  })
})
