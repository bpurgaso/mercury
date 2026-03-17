# Channel Type Selector

## Problem Statement

Users cannot create voice or video channels through the UI. The server API supports `text`, `voice`, and `video` channel types, and the client already renders voice channels correctly in `ChannelList` and supports joining calls via `VoiceChannelEntry`. However, `CreateChannelModal` only exposes encryption mode selection — it always creates text channels because `channel_type` is never passed to the API.

Server owners who want voice channels currently have no way to create them without calling the REST API directly.

## Proposed Solution

Add a channel type step to `CreateChannelModal` that lets users choose between **Text** and **Voice** before selecting encryption mode. Pass the selected type through the store to the API.

Voice channels implicitly support video (the call UI already has a camera toggle), so we do not expose "video" as a separate user-facing type. The API value `"voice"` is used for both.

## Goals

- Users can create voice channels from the same modal used for text channels
- The change is minimal — one new UI step, one store signature update, one API field addition
- No server-side changes required (the API already accepts `channel_type`)

## Non-Goals

- Adding a standalone "video" channel type to the UI (voice channels already support video)
- Changing how voice channels render in `ChannelList` or how calls work
- Adding channel type editing after creation
- Reworking the modal layout or visual design

## Detailed Design

### 1. CreateChannelModal UI Changes

Add a **channel type selector** above the existing encryption mode selector. Two options:

- **Text Channel** — icon: `#` hash. Description: "Send messages, images, and files."
- **Voice Channel** — icon: speaker/volume. Description: "Voice and video chat with members."

The selector uses the same radio-button card pattern already used for encryption mode.

New state: `channelType: 'text' | 'voice'` (default: `'text'`).

When `channelType` is `'voice'`:
- The placeholder for channel name changes from `"general"` to `"voice-chat"`.
- Encryption mode selection remains available (voice channels can be private/E2E encrypted).

### 2. Store Signature Change

`useServerStore.createChannel` adds a `channelType` parameter:

```typescript
// Before
createChannel(serverId: string, name: string, encryptionMode: 'standard' | 'private'): Promise<Channel>

// After
createChannel(serverId: string, name: string, channelType: 'text' | 'voice', encryptionMode: 'standard' | 'private'): Promise<Channel>
```

The implementation passes `channel_type` in the API request body:

```typescript
async createChannel(serverId, name, channelType, encryptionMode) {
  const channel = await channelsApi.create(serverId, {
    name,
    channel_type: channelType,
    encryption_mode: encryptionMode,
  })
  get().addChannel(channel)
  return channel
}
```

### 3. Post-Creation Navigation

After creating a text channel, the modal calls `setActiveChannel(channel.id)` as it does today (navigating to the new channel's message view).

After creating a voice channel, the modal does **not** call `setActiveChannel` — voice channels don't have a message view to navigate to. The new channel appears in the voice channels section of the sidebar.

## Edge Cases

- **Empty server (no channels):** Works normally. The new voice channel appears in the Voice Channels section.
- **Private voice channel with >100 members:** The existing `privateDisabled` logic already handles this — the Private option is disabled with an explanation, regardless of channel type.
- **Channel name validation:** Unchanged. Server enforces 1–100 characters.

## Acceptance Criteria

1. `CreateChannelModal` shows a channel type selector with "Text Channel" and "Voice Channel" options
2. Selecting "Voice Channel" and submitting creates a channel with `channel_type: "voice"` via the API
3. The new voice channel appears in the "Voice Channels" section of `ChannelList`
4. Text channel remains the default selection
5. Encryption mode selection works for both channel types
6. After creating a voice channel, the user is not navigated away from their current view
7. The placeholder text updates based on channel type selection
