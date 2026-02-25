# Phase 8 Session 4: Voice/Video UI and Connectivity Diagnostics

## Problem Statement

Sessions 1–3 established SFU routing, WebRTC connectivity, and media E2E encryption. Users can programmatically join calls and exchange encrypted media, but there is no UI for controlling or observing voice/video calls. Users need:

- Visual controls for joining/leaving voice channels, muting, deafening, and toggling camera
- A video grid that adapts to participant count
- Active speaker detection so users know who is talking
- Connectivity diagnostics when WebRTC fails to connect
- Visual indicators in the channel/member list showing active calls
- Audio cues for join/leave events

## Proposed Solution

Build six UI features on top of the existing `callStore`, `webRTCManager`, and WebSocket infrastructure:

1. **Voice Channel Panel** — persistent panel at the bottom of the channel sidebar showing call state and controls
2. **Video Grid** — adaptive layout that switches between 2x2, speaker+filmstrip, and speaker+paginated modes
3. **Active Speaker Detection** — audio-level polling service that identifies who is speaking
4. **Connectivity Diagnostic Panel** — step-by-step ICE check UI when connection fails
5. **Call State Indicators** — channel list and member list annotations for active calls
6. **Join/Leave Audio Cues** — local sound effects when participants enter/leave

## Goals

- Users can join/leave voice channels, mute, deafen, and toggle camera entirely through the UI
- Video grid renders correctly for 1–4, 5–9, and 10+ participants
- Active speaker is visually indicated within 300ms of speech onset
- When WebRTC fails, users see actionable diagnostic information instead of a generic error
- Channel list shows which voice channels have active calls and how many participants
- Join/leave sounds play reliably for local awareness

## Non-Goals

- Screen sharing (future session)
- Push-to-talk mode
- Noise gate / noise suppression settings UI
- Mobile/responsive layout
- Server-side voice activity detection
- Video quality selector UI (the `setPreferredVideoQuality` API exists but no UI yet)

---

## Detailed Design

### 1. Voice Channel Panel

**Component**: `VoicePanel.tsx` in `components/voice/`

**Placement**: Rendered at the bottom of `ChannelList.tsx`, above the user area. Persists across channel navigation because `callStore.activeCall` is global state independent of `activeChannelId`.

**State sources**:
- `useCallStore` — `activeCall`, `participants`, `isMuted`, `isDeafened`, `isCameraOn`
- `useServerStore` — channel name lookup via `channels.get(activeCall.channelId)`
- New: `useCallStore.callDuration` — elapsed seconds since call join (computed from `activeCall.joinedAt`)

**Sub-components**:

```
VoicePanel
├── VoicePanelHeader          (channel name + duration timer)
├── VoiceParticipantList      (scrollable list of participants)
│   └── VoiceParticipant      (username, speaking indicator, mute/deaf icons)
└── VoiceControls             (mute, deafen, camera, disconnect buttons)
```

**VoicePanelHeader**:
- Channel name from server store
- Duration timer: store `joinedAt: number` (Date.now()) in callStore when `joinCall` succeeds. Component uses `useEffect` + `setInterval(1000)` to compute elapsed time and format as `mm:ss` or `h:mm:ss`.

**VoiceParticipantList**:
- Iterates `participants` Map from callStore
- Each participant shows:
  - Username (looked up from a user cache — we'll use a `displayNames` map in callStore populated from VOICE_STATE_UPDATE, or fall back to `user_id`)
  - Green ring/border when `isSpeaking` (from active speaker detection store)
  - Mute icon (microphone-off SVG) when `selfMute === true`
  - Deaf icon (headphone-off SVG) when `selfDeaf === true`
- Local user is also shown (from `useAuthStore.user`)

**VoiceControls**:
- **Mute button**: microphone icon, toggles between mic-on (default) and mic-off (red). Calls `callStore.toggleMute()`.
- **Deafen button**: headphone icon, toggles between headphone-on and headphone-off (red). Calls `callStore.toggleDeafen()`.
- **Camera button**: camera icon, toggles on/off. Calls `callStore.toggleCamera()`.
- **Disconnect button**: red phone-hangup icon. Calls `callStore.leaveCall()`.

**Store changes** (`callStore.ts`):
- Add `joinedAt: number | null` to `CallState`. Set to `Date.now()` after successful `joinCall`, reset to `null` on `leaveCall`/`cleanUpCall`.
- Add `displayNames: Map<string, string>` — populated when VOICE_STATE_UPDATE arrives. The server should include `username` in the event payload. If not available, fall back to the user_id.

### 2. Video Grid

**Component**: `VideoGrid.tsx` in `components/voice/`

**Placement**: Rendered in the main content area (replacing or overlaying the chat area in `ServerPage.tsx`) when any participant has video enabled (`hasVideo === true` in any participant, or local `isCameraOn`).

**Layout modes** (determined by total video-enabled participant count):

| Count | Layout | Description |
|-------|--------|-------------|
| 1     | Single tile, centered | One large tile |
| 2–4   | 2x2 equal grid | `grid-cols-2` with equal tiles |
| 5–9   | Speaker + filmstrip | Active speaker large (75% height), horizontal filmstrip of others below |
| 10+   | Speaker + paginated grid | Active speaker large (60% height), paginated 3x2 grid below with prev/next |

**VideoTile sub-component**:
- Renders a `<video>` element with `srcObject` set to the participant's MediaStream
- If camera is off: shows avatar (first letter of username in a circle, same as sidebar)
- Username overlay at bottom-left (semi-transparent bg)
- Mute indicator icon at bottom-right if `selfMute`
- Green border (2px) when `isSpeaking`
- Local video tile is mirrored (`transform: scaleX(-1)`)

**Stream binding**:
- Local: `callStore.localStream`
- Remote: `callStore.remoteStreams.get(userId)`

**Pagination** (10+ mode):
- State: `currentPage` (0-indexed), items per page = 6 (3x2)
- Show page dots or "Page X of Y" indicator
- Left/right arrow buttons

### 3. Active Speaker Detection

**Service**: `ActiveSpeakerDetector` class in `services/active-speaker.ts`

**Approach**: Use `AudioContext` + `AnalyserNode` for local audio and `RTCRtpReceiver.getStats()` for remote audio. We'll prefer the stats-based approach for remote participants since it doesn't require creating AudioContext nodes for each remote stream.

**Implementation**:

```typescript
class ActiveSpeakerDetector {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private speakingState: Map<string, { level: number; since: number }> = new Map()
  private callbacks = new Set<(speakers: Map<string, boolean>) => void>()

  // Configuration
  private readonly POLL_INTERVAL_MS = 100
  private readonly SPEAKING_THRESHOLD = 0.015  // audio level threshold (0–1)
  private readonly SPEAKING_DURATION_MS = 200   // must exceed threshold for this long

  start(localUserId: string, localStream: MediaStream | null): void
  stop(): void
  onSpeakingChange(cb: (speakers: Map<string, boolean>) => void): () => void
}
```

**Polling loop** (every 100ms):
1. **Local audio**: Create an `AnalyserNode` from the local audio track. Read `getByteTimeDomainData()`, compute RMS level. If > threshold for > 200ms → mark local user as speaking.
2. **Remote audio**: Call `pc.getStats()` → iterate `RTCInboundRtpStreamStats` entries with `kind === 'audio'`. Use `audioLevel` stat (0–1 range). If > threshold for > 200ms → mark that user as speaking.
3. **Active speaker**: The participant with the highest audio level among those currently speaking is the "active speaker".
4. Fire callbacks with updated speaking map.

**Store integration** (`callStore.ts`):
- Add `speakingUsers: Map<string, boolean>` to state
- Add `activeSpeakerId: string | null` to state
- Start detector on `joinCall()`, stop on `leaveCall()`/`cleanUpCall()`
- Detector callback updates `speakingUsers` and `activeSpeakerId` in the store

### 4. Connectivity Diagnostic Panel

**Component**: `DiagnosticPanel.tsx` in `components/voice/`

**Trigger**: Shown when `callStore.diagnosticState?.failed === true` (set after 10s of WebRTC 'failed' state by existing `webRTCManager.onDiagnosticTimeout`).

**Service**: `IceDiagnosticRunner` class in `services/ice-diagnostics.ts`

**ICE connectivity checks** (run in sequence, results shown progressively):

| Check | Method | Pass condition |
|-------|--------|---------------|
| WebSocket signaling | `wsManager.getState() === 'CONNECTED'` | Already connected |
| STUN binding | Create temp `RTCPeerConnection` with only STUN server, create data channel, create offer, wait for `srflx` candidate within 5s | At least one `srflx` candidate gathered |
| TURN relay (UDP) | Create temp `RTCPeerConnection` with TURN UDP server, create data channel, create offer, wait for `relay` candidate within 5s | At least one `relay` candidate gathered |
| TURN relay (TCP) | Same as above but with TURN TCP URL | At least one `relay` candidate gathered |

**Result state**:
```typescript
interface DiagnosticResult {
  websocket: 'pending' | 'pass' | 'fail'
  stun: 'pending' | 'pass' | 'fail'
  turnUdp: 'pending' | 'pass' | 'fail'
  turnTcp: 'pending' | 'pass' | 'fail'
  timeToConnectedMs: number | null
}
```

**UI**:
```
Connection Diagnostic
  ✓ WebSocket signaling ......... connected
  ✓ STUN binding ................ reachable
  ✗ TURN relay (UDP) ............ failed
  ~ TURN relay (TCP) ............ checking...

  Your network may be blocking UDP traffic. Try:
  • Switching to a different network
  • Contacting your server administrator

  [Retry] [Dismiss]
```

- Each line updates in real-time as checks complete
- Checkmark (green), X (red), spinner/tilde (yellow) for pending
- Contextual advice based on which checks fail
- "Retry" button re-runs all checks
- "Dismiss" closes the panel

**ICE_DIAGNOSTIC WebSocket event**:
After all checks complete, send via WebSocket:
```typescript
wsManager.send('ice_diagnostic', {
  call_id: activeCall.roomId,
  stun: boolean,
  turn_udp: boolean,
  turn_tcp: boolean,
  time_to_connected_ms: number | null
})
```

**WS type additions**:
- Add `'ice_diagnostic'` to `ClientOp` type
- Add `IceDiagnosticPayload` interface

### 5. Call State Indicators

**Channel list changes** (`ChannelList.tsx`):
- Voice channels (type `'voice'`) are now rendered in their own section below text channels
- Each voice channel shows:
  - Speaker icon + participant count if an active call exists (`callStore.activeChannelCalls.has(channel.id)`)
  - Click to join: calls `callStore.joinCall(channel.id)`
  - If already in this channel, highlight as active
- Participant names shown nested under the voice channel entry (compact list)

**Data flow**:
- `callStore.activeChannelCalls` (Map<channelId, roomId>) tracks which channels have active calls
- For participant count: we need the server to broadcast participant counts. The `CALL_STARTED` event already fires. We'll extend the store to track `voiceChannelParticipants: Map<channelId, Set<userId>>` populated from `VOICE_STATE_UPDATE` events (even for channels the user isn't in).

**Store changes** (`callStore.ts`):
- Add `voiceChannelParticipants: Map<string, Set<string>>` to state
- Update from all `VOICE_STATE_UPDATE` events (not just for the active call):
  - If `channel_id !== null`: add `user_id` to `voiceChannelParticipants[channel_id]`
  - If `channel_id === null`: remove `user_id` from all sets
- This provides both the count and the user list for display

**Member list indicator**:
- Users in a voice channel show a small green phone icon next to their name
- Uses `voiceChannelParticipants` to check if a user_id is in any voice channel

### 6. Join/Leave Audio Cues

**Implementation**: Preload two short audio files and play them via the Web Audio API.

**Assets**: `src/client/src/renderer/assets/sounds/join.mp3` and `leave.mp3`
- These are short (< 0.5s) audio files
- We'll create simple synthesized tones using `AudioContext.createOscillator()` to avoid bundling audio files:
  - Join: ascending two-note chime (C5 → E5, 100ms each)
  - Leave: descending two-note chime (E5 → C5, 100ms each)

**Service**: `AudioCuePlayer` class in `services/audio-cues.ts`

```typescript
class AudioCuePlayer {
  private ctx: AudioContext | null = null

  playJoin(): void    // ascending chime
  playLeave(): void   // descending chime
  dispose(): void
}
```

**Trigger**:
- In `callStore`'s `VOICE_STATE_UPDATE` handler:
  - When a new participant joins the active call → `audioCuePlayer.playJoin()`
  - When a participant leaves the active call → `audioCuePlayer.playLeave()`

---

## Edge Cases

1. **User navigates away while in call**: Panel persists because it's rendered in `ChannelList` which is always visible. `activeCall` state is independent of `activeChannelId`.

2. **User closes app while in call**: `beforeunload` handler in callStore calls `leaveCall()`. Also, the server detects WebSocket disconnect and cleans up the participant.

3. **Multiple rapid join/leave**: Debounce audio cues — don't stack multiple sounds. Use a cooldown of 200ms.

4. **No getUserMedia permission**: `joinCall` already handles this — surfaces error. The voice panel should show the error message.

5. **Video grid with mixed camera on/off**: Tiles show avatar placeholder for users with camera off. Only users with video enabled count toward layout mode decisions.

6. **Active speaker with all muted**: No one highlighted. `activeSpeakerId` is null.

7. **Diagnostic panel with no TURN config**: Skip TURN checks if `callConfig.turnUrls` is empty. Show "No TURN servers configured" with appropriate advice.

8. **10+ participants paginated grid**: Current page adjusts if participants leave and the current page would be empty.

9. **AudioContext autoplay policy**: Create AudioContext on first user interaction (mute/unmute button click) to comply with browser autoplay restrictions. Store the context and reuse.

10. **Duration timer accuracy**: Use `Date.now()` at join time and compute elapsed on each interval tick, rather than incrementing a counter (avoids drift).

---

## Acceptance Criteria

### Voice Channel Panel
- [ ] Panel appears at bottom of channel sidebar when user joins a voice call
- [ ] Shows channel name and connected duration (mm:ss format)
- [ ] Lists all participants with username
- [ ] Speaking participants have green border indicator
- [ ] Muted participants show microphone-off icon
- [ ] Deafened participants show headphone-off icon
- [ ] Mute button toggles local mute state
- [ ] Deafen button toggles deafen (also mutes) and restores previous mute state on undeafen
- [ ] Camera button toggles camera
- [ ] Disconnect button leaves the call and removes the panel
- [ ] Panel persists when navigating to other channels

### Video Grid
- [ ] 1 participant: single centered tile
- [ ] 2–4 participants: 2x2 equal grid
- [ ] 5–9 participants: active speaker large + filmstrip
- [ ] 10+ participants: active speaker large + paginated 3x2 grid
- [ ] Each tile shows video stream or avatar placeholder
- [ ] Username overlay on each tile
- [ ] Mute indicator on tile if participant is muted
- [ ] Speaking indicator (green border) on active speaker's tile
- [ ] Local video is mirrored

### Active Speaker Detection
- [ ] Audio levels polled every 100ms
- [ ] Participant marked as speaking after level exceeds threshold for 200ms
- [ ] Loudest speaking participant is the "active speaker"
- [ ] Green border shown on speaking participant's tile/name in panel
- [ ] No speaker highlighted when all are silent

### Connectivity Diagnostics
- [ ] Diagnostic panel shown when WebRTC connection fails after 10s
- [ ] Shows WebSocket, STUN, TURN UDP, TURN TCP check results
- [ ] Results update progressively as checks complete
- [ ] Contextual advice displayed based on failure pattern
- [ ] ICE_DIAGNOSTIC event sent to server with results
- [ ] Retry button re-runs all checks
- [ ] Dismiss button hides the panel

### Call State Indicators
- [ ] Voice channels listed in channel sidebar with appropriate icon
- [ ] Active voice channels show speaker icon + participant count
- [ ] Clicking a voice channel joins the call
- [ ] Users in voice channels show phone icon in member list

### Audio Cues
- [ ] Join sound plays when a participant joins the user's active call
- [ ] Leave sound plays when a participant leaves the user's active call
- [ ] Sounds are local-only (not transmitted over WebRTC)
- [ ] Sounds don't stack/overlap with rapid join/leave

### Tests (Vitest)
- [ ] Voice panel renders with mock participants, shows names/mute/speaking indicators
- [ ] Video grid layout: 2 → 2 tiles, 4 → 2x2, 5 → speaker+filmstrip, 10 → speaker+paginated
- [ ] Mute button click calls toggleMute, icon changes
- [ ] Deafen button click calls toggleDeafen, icon changes, mute activates
- [ ] Camera toggle calls toggleCamera, video grid appears/disappears
- [ ] Diagnostic panel shows correct check results with mocked ICE failures
- [ ] ICE_DIAGNOSTIC WebSocket event sent with correct fields
- [ ] Active speaker detection marks correct participant
- [ ] Call state indicators show speaker icon and count

### Tests (Playwright E2E)
- [ ] Two users join voice channel, both see each other in voice panel, audio bytes flow
- [ ] Mute: other user sees mute icon, audio bytes stop
- [ ] Deafen: also mutes, remote audio tracks disabled
- [ ] Camera: video tile appears/disappears for other user
- [ ] Third user joins → key rotation (epoch incremented), all three have audio
- [ ] User leaves → key rotation, remaining two connected
- [ ] Disconnect button → user leaves, panel disappears
- [ ] Standard channel voice: multiple users can join voice channel in a server

---

## File Plan

### New Files
| File | Purpose |
|------|---------|
| `src/client/src/renderer/components/voice/VoicePanel.tsx` | Voice panel container |
| `src/client/src/renderer/components/voice/VoicePanelHeader.tsx` | Channel name + timer |
| `src/client/src/renderer/components/voice/VoiceParticipantList.tsx` | Participant list |
| `src/client/src/renderer/components/voice/VoiceParticipant.tsx` | Single participant row |
| `src/client/src/renderer/components/voice/VoiceControls.tsx` | Control buttons |
| `src/client/src/renderer/components/voice/VideoGrid.tsx` | Adaptive video grid |
| `src/client/src/renderer/components/voice/VideoTile.tsx` | Single video tile |
| `src/client/src/renderer/components/voice/DiagnosticPanel.tsx` | ICE diagnostic UI |
| `src/client/src/renderer/components/voice/VoiceChannelEntry.tsx` | Voice channel in sidebar |
| `src/client/src/renderer/services/active-speaker.ts` | Speaker detection service |
| `src/client/src/renderer/services/ice-diagnostics.ts` | ICE diagnostic runner |
| `src/client/src/renderer/services/audio-cues.ts` | Join/leave sound effects |
| `src/client/tests/unit/components/voice-panel.test.ts` | Voice panel unit tests |
| `src/client/tests/unit/components/video-grid.test.ts` | Video grid unit tests |
| `src/client/tests/unit/services/active-speaker.test.ts` | Speaker detection tests |
| `src/client/tests/unit/services/ice-diagnostics.test.ts` | ICE diagnostic tests |
| `src/client/tests/e2e/flows/voice-channel.test.ts` | E2E voice/video tests |

### Modified Files
| File | Changes |
|------|---------|
| `src/client/src/renderer/stores/callStore.ts` | Add `joinedAt`, `displayNames`, `speakingUsers`, `activeSpeakerId`, `voiceChannelParticipants`; integrate speaker detector and audio cues |
| `src/client/src/renderer/types/call.ts` | Add `speaking` field to ParticipantState |
| `src/client/src/renderer/types/ws.ts` | Add `ice_diagnostic` to ClientOp, add `IceDiagnosticPayload` |
| `src/client/src/renderer/components/layout/ChannelList.tsx` | Add voice channel section with call indicators, render VoicePanel |
| `src/client/src/renderer/pages/ServerPage.tsx` | Conditionally render VideoGrid when video is active |
