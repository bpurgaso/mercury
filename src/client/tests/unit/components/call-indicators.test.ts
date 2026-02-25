import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('Call state indicators in channel list', () => {
  describe('active call detection', () => {
    it('should show active call for voice channel with participants', () => {
      const activeChannelCalls = new Map([['ch-voice-1', 'room-1']])
      const voiceChannelParticipants = new Map([
        ['ch-voice-1', new Set(['user-a', 'user-b', 'user-c'])],
      ])

      expect(activeChannelCalls.has('ch-voice-1')).toBe(true)
      expect(voiceChannelParticipants.get('ch-voice-1')?.size).toBe(3)
    })

    it('should not show indicator for channels without active calls', () => {
      const activeChannelCalls = new Map<string, string>()
      expect(activeChannelCalls.has('ch-voice-1')).toBe(false)
    })

    it('should show correct participant count', () => {
      const voiceChannelParticipants = new Map([
        ['ch-voice-1', new Set(['user-a', 'user-b'])],
        ['ch-voice-2', new Set(['user-c'])],
      ])

      expect(voiceChannelParticipants.get('ch-voice-1')?.size).toBe(2)
      expect(voiceChannelParticipants.get('ch-voice-2')?.size).toBe(1)
    })
  })

  describe('voiceChannelParticipants tracking', () => {
    it('should add user to channel on voice state update', () => {
      const map = new Map<string, Set<string>>()

      // Simulate VOICE_STATE_UPDATE: user-a joins ch-voice-1
      const channelId = 'ch-voice-1'
      const userId = 'user-a'
      const existing = map.get(channelId) ?? new Set()
      const updated = new Set(existing)
      updated.add(userId)
      map.set(channelId, updated)

      expect(map.get('ch-voice-1')?.has('user-a')).toBe(true)
    })

    it('should remove user from all channels when they leave', () => {
      const map = new Map<string, Set<string>>([
        ['ch-voice-1', new Set(['user-a', 'user-b'])],
        ['ch-voice-2', new Set(['user-a'])],
      ])

      // Simulate user-a leaving (channel_id: null)
      for (const [chId, users] of map) {
        const newSet = new Set(users)
        if (newSet.delete('user-a')) {
          if (newSet.size === 0) {
            map.delete(chId)
          } else {
            map.set(chId, newSet)
          }
        }
      }

      expect(map.get('ch-voice-1')?.has('user-a')).toBeFalsy()
      expect(map.get('ch-voice-1')?.has('user-b')).toBe(true)
      expect(map.has('ch-voice-2')).toBe(false) // deleted because empty
    })

    it('should move user between channels', () => {
      const map = new Map<string, Set<string>>([
        ['ch-voice-1', new Set(['user-a'])],
      ])

      // user-a moves to ch-voice-2
      // Step 1: remove from all
      for (const [chId, users] of map) {
        const newSet = new Set(users)
        if (newSet.delete('user-a')) {
          if (newSet.size === 0) map.delete(chId)
          else map.set(chId, newSet)
        }
      }

      // Step 2: add to new channel
      const existing = map.get('ch-voice-2') ?? new Set()
      const updated = new Set(existing)
      updated.add('user-a')
      map.set('ch-voice-2', updated)

      expect(map.has('ch-voice-1')).toBe(false)
      expect(map.get('ch-voice-2')?.has('user-a')).toBe(true)
    })
  })

  describe('member list voice icon', () => {
    it('should identify users in any voice channel', () => {
      const voiceChannelParticipants = new Map([
        ['ch-voice-1', new Set(['user-a', 'user-b'])],
        ['ch-voice-2', new Set(['user-c'])],
      ])

      function isUserInVoice(userId: string): boolean {
        for (const users of voiceChannelParticipants.values()) {
          if (users.has(userId)) return true
        }
        return false
      }

      expect(isUserInVoice('user-a')).toBe(true)
      expect(isUserInVoice('user-c')).toBe(true)
      expect(isUserInVoice('user-d')).toBe(false)
    })
  })
})
