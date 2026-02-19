import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the api module
vi.mock('../../../src/renderer/services/api', () => ({
  messages: {
    getHistory: vi.fn(),
  },
  setTokenProvider: vi.fn(),
}))

// Mock the websocket module
vi.mock('../../../src/renderer/services/websocket', () => ({
  wsManager: {
    send: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}))

import { useMessageStore } from '../../../src/renderer/stores/messageStore'
import { messages as messagesApi } from '../../../src/renderer/services/api'
import { wsManager } from '../../../src/renderer/services/websocket'
import type { Message } from '../../../src/renderer/types/models'

const makeMessage = (id: string, channelId: string, content: string): Message => ({
  id,
  channel_id: channelId,
  sender_id: 'user-1',
  content,
  message_type: 'text',
  created_at: new Date().toISOString(),
  edited_at: null,
})

describe('messageStore', () => {
  beforeEach(() => {
    useMessageStore.setState({ messages: new Map() })
    vi.clearAllMocks()
  })

  it('addMessage appends a message to channel list', () => {
    const msg = makeMessage('m1', 'c1', 'Hello')

    useMessageStore.getState().addMessage('c1', msg)

    const messages = useMessageStore.getState().getChannelMessages('c1')
    expect(messages.length).toBe(1)
    expect(messages[0].content).toBe('Hello')
  })

  it('addMessage does not duplicate messages', () => {
    const msg = makeMessage('m1', 'c1', 'Hello')

    useMessageStore.getState().addMessage('c1', msg)
    useMessageStore.getState().addMessage('c1', msg) // same id

    const messages = useMessageStore.getState().getChannelMessages('c1')
    expect(messages.length).toBe(1)
  })

  it('addMessage appends to existing messages', () => {
    useMessageStore.getState().addMessage('c1', makeMessage('m1', 'c1', 'First'))
    useMessageStore.getState().addMessage('c1', makeMessage('m2', 'c1', 'Second'))

    const messages = useMessageStore.getState().getChannelMessages('c1')
    expect(messages.length).toBe(2)
    expect(messages[0].content).toBe('First')
    expect(messages[1].content).toBe('Second')
  })

  it('handleMessageCreate converts event to message and adds it', () => {
    useMessageStore.getState().handleMessageCreate({
      id: 'm1',
      channel_id: 'c1',
      sender_id: 'user-1',
      content: 'From WS',
      created_at: '2025-01-01T00:00:00Z',
    })

    const messages = useMessageStore.getState().getChannelMessages('c1')
    expect(messages.length).toBe(1)
    expect(messages[0].content).toBe('From WS')
  })

  it('fetchHistory prepends messages to the channel', async () => {
    // Existing messages
    useMessageStore.getState().addMessage('c1', makeMessage('m3', 'c1', 'Third'))

    // History from API
    const history = [
      makeMessage('m1', 'c1', 'First'),
      makeMessage('m2', 'c1', 'Second'),
    ]
    vi.mocked(messagesApi.getHistory).mockResolvedValue(history)

    await useMessageStore.getState().fetchHistory('c1')

    const messages = useMessageStore.getState().getChannelMessages('c1')
    expect(messages.length).toBe(3)
    // History is prepended
    expect(messages[0].content).toBe('First')
    expect(messages[1].content).toBe('Second')
    expect(messages[2].content).toBe('Third')
  })

  it('fetchHistory does not duplicate existing messages', async () => {
    useMessageStore.getState().addMessage('c1', makeMessage('m1', 'c1', 'First'))

    // API returns same message
    vi.mocked(messagesApi.getHistory).mockResolvedValue([makeMessage('m1', 'c1', 'First')])

    await useMessageStore.getState().fetchHistory('c1')

    const messages = useMessageStore.getState().getChannelMessages('c1')
    expect(messages.length).toBe(1)
  })

  it('sendMessage sends via WebSocket', () => {
    useMessageStore.getState().sendMessage('c1', 'Hello world')

    expect(wsManager.send).toHaveBeenCalledWith('message_send', {
      channel_id: 'c1',
      content: 'Hello world',
    })
  })

  it('getChannelMessages returns empty array for unknown channel', () => {
    const messages = useMessageStore.getState().getChannelMessages('unknown')
    expect(messages).toEqual([])
  })
})
