# Phase 9 Session 4 — Moderation Dashboard UI

**Status:** Draft
**Depends on:** Phase 9 Sessions 1–3 (moderation store, report dialog, block system, API endpoints)

---

## Problem Statement

Server owners and moderators need a centralized dashboard to review content reports, monitor automated abuse signals, manage bans, and audit moderation actions. Without this UI, the moderation infrastructure built in Sessions 1–3 is inaccessible. The dashboard must clearly communicate the "unverified evidence" problem for E2E encrypted channels — moderators must understand they cannot cryptographically verify reported content from encrypted contexts.

---

## Proposed Solution

Build a tabbed moderation dashboard accessible from the channel list for server owners/moderators. The dashboard includes:

1. **ReportQueue** — paginated, filterable list of content reports
2. **ReportDetail** — full report view with evidence decryption, verification banners, metadata corroboration, and action buttons
3. **AbuseSignalList** — automated abuse signal viewer
4. **BanList** — ban management (view, add, remove)
5. **AuditLog** — chronological read-only log of all moderation actions
6. **Operator setup wizard** — moderation keypair generation/import for evidence decryption

---

## Goals

- Owner and moderators can access the dashboard; non-moderators cannot
- Reports are viewable with all metadata; evidence can be decrypted when operator has moderation key
- E2E channel reports show prominent unverified-evidence warnings
- Standard channel reports show verification status
- Moderators can take actions (dismiss, warn, mute, kick, ban) directly from report detail
- Abuse signals are viewable and can be marked reviewed
- Bans are listed with unban capability and add-ban flow
- Audit log provides chronological accountability for all moderation actions
- All components are paginated with filter controls
- Comprehensive Vitest unit tests and Playwright E2E tests

---

## Non-Goals

- Message franking / cryptographic proof of message authenticity (v2)
- Cross-server moderation or trust networks
- Automated ban sync across servers
- Real-time collaborative moderation (multi-moderator locks)
- Mobile-responsive layout (desktop-only)

---

## Detailed Design

### 1. Access Control & Navigation

**Entry point:** A shield icon button in the `ChannelList` component header, visible only to the server owner (`server.owner_id === user.id`) or users with `is_moderator: true` in the server's member list.

**Access check:** The `ModerationDashboard` component checks on mount:
```typescript
const server = servers.get(activeServerId)
const user = useAuthStore((s) => s.user)
const members = useServerStore((s) => s.members)
const memberList = members.get(activeServerId) || []
const currentMember = memberList.find(m => m.user_id === user?.id)
const isOwner = server?.owner_id === user?.id
const isModerator = currentMember?.is_moderator === true
const hasAccess = isOwner || isModerator
```

If `!hasAccess`, do not render the dashboard (the button shouldn't be visible either, but defense in depth).

**State management:** A new `moderationView` field in `serverStore` or local state in `ChannelList`:
- `null` → normal channel list view
- `'dashboard'` → show ModerationDashboard instead of channel list content area

### 2. ModerationDashboard Component

**File:** `src/renderer/components/moderation/ModerationDashboard.tsx`

**Layout:**
```
┌──────────────────────────────────────────────┐
│  Server Name — Moderation Dashboard    [X]   │
├──────┬───────────────────────────────────────┤
│ Tabs │ Content Area                          │
│      │                                       │
│ ● Reports (3)                                │
│   Abuse Signals (1)                          │
│   Bans                                       │
│   Audit Log                                  │
│      │                                       │
└──────┴───────────────────────────────────────┘
```

- Header: server name + "Moderation Dashboard" + close button
- Left: vertical tab bar with notification badges (pendingReportCount, pendingAbuseSignalCount)
- Right: active tab content
- Tabs: Reports, Abuse Signals, Bans, Audit Log
- On mount: calls `fetchReports(serverId)`, `fetchAbuseSignals(serverId)`, `fetchBans(serverId)`, `fetchAuditLog(serverId)`

### 3. Store Additions

**File:** `src/renderer/stores/moderationStore.ts`

Add methods the dashboard needs that are currently missing:

```typescript
// New state
activeTab: 'reports' | 'abuse_signals' | 'bans' | 'audit_log'
selectedReportId: string | null

// New methods
fetchAbuseSignals(serverId: string): Promise<void>
fetchBans(serverId: string): Promise<void>
markAbuseSignalReviewed(signalId: string): Promise<void>
setActiveTab(tab: string): void
setSelectedReport(reportId: string | null): void
```

**API additions** (in `services/api.ts`):

```typescript
// Abuse signals
getAbuseSignals: (serverId: string) =>
  request<AbuseSignalsResponse>(`/servers/${serverId}/abuse-signals`),
markAbuseSignalReviewed: (signalId: string) =>
  request<void>(`/abuse-signals/${signalId}/reviewed`, { method: 'POST' }),

// Single report (for evidence blob)
getReport: (reportId: string) =>
  request<ReportResponse>(`/reports/${reportId}`),

// User metadata for corroboration
getUserMetadata: (serverId: string, userId: string) =>
  request<UserModerationMetadata>(`/servers/${serverId}/users/${userId}/moderation-metadata`),

// Moderation key management
setModerationKey: (serverId: string, publicKey: string) =>
  request<void>(`/servers/${serverId}/moderation-key`, {
    method: 'PUT',
    body: JSON.stringify({ public_key: publicKey }),
  }),
```

**New types** (in `types/models.ts`):

```typescript
export interface UserModerationMetadata {
  user_id: string
  username: string
  account_created_at: string
  server_joined_at: string
  message_count_30d: number
  report_count_total: number
  report_count_recent: number  // last 30 days
  active_abuse_signals: number
  previous_actions: AuditLogEntry[]
}
```

**New API types** (in `types/api.ts`):

```typescript
export type UserModerationMetadataResponse = UserModerationMetadata
```

### 4. ReportQueue Component

**File:** `src/renderer/components/moderation/ReportQueue.tsx`

**Props:** `{ serverId: string }`

**Features:**
- Reads `reports` from moderationStore
- Filter controls:
  - Status: All / Pending / Reviewed / Dismissed (dropdown or button group)
  - Category: All / Spam / Harassment / Illegal / CSAM / Other
  - Date range: simple "Last 24h / 7d / 30d / All" selector
- Rows show: reporter username, reported user, category, timestamp (relative), status badge
- Status badges: Pending (yellow), Reviewed (blue), Dismissed (gray)
- Click row → `setSelectedReport(reportId)` → switches content area to ReportDetail
- Pagination: "Load More" button at bottom (cursor-based)

### 5. ReportDetail Component

**File:** `src/renderer/components/moderation/ReportDetail.tsx`

**Props:** `{ reportId: string, serverId: string, onBack: () => void }`

This is the most UX-critical component. Sections:

#### 5a. Report Metadata
- Reporter username, reported user, category, description, timestamp
- Server name, channel name (if available)

#### 5b. Evidence Section
- **If `evidence_blob` present:**
  1. Button: "Decrypt Evidence" (requires operator's moderation private key)
  2. On click: post to Worker `{ op: 'decrypt_report_evidence', evidence_blob, moderationPrivKey }`
  3. Worker decrypts → returns plaintext evidence JSON
  4. Display: message content, sender, timestamp, channel
  5. If decryption fails (key not available): show error with link to operator setup
- **If no `evidence_blob`:**
  Show info box: "No message content included. Reporter provided only metadata."

#### 5c. UnverifiedReportBanner Component

**File:** `src/renderer/components/moderation/UnverifiedReportBanner.tsx`

For E2E encrypted channels (channel `encryption_mode === 'private'` or DM channels):
```
⚠️ Cannot be cryptographically verified

This report includes content from an end-to-end encrypted channel.
Because messages are encrypted, there is no cryptographic proof that
the reported content is authentic. The reporter could have modified
the message before submitting this report. Consider corroborating
with metadata, message patterns, and other reports before taking action.
```

For standard (plaintext) channels:
```
✓ Verified — server has original message

The server retains the original message for standard channels.
```

**Logic:** Determine channel type from `report.channel_id`:
- Look up channel in serverStore → check `encryption_mode`
- If channel not found (e.g., DM), check if `report.channel_id` starts with a DM channel pattern or is absent → treat as unverifiable
- DMs are always E2E → always show unverified banner

#### 5d. MetadataCorroboration Component

**File:** `src/renderer/components/moderation/MetadataCorroboration.tsx`

**Props:** `{ serverId: string, userId: string }`

Fetches `getUserMetadata(serverId, userId)` on mount and displays:
- Account age (e.g., "Created 3 months ago")
- Server join date (e.g., "Joined 2 weeks ago")
- Message frequency (e.g., "142 messages in last 30 days")
- Reports received: total + recent count
- Active abuse signals count
- Previous moderation actions (table: date, action, moderator, reason)

#### 5e. Action Buttons

Horizontal button bar at the bottom of ReportDetail:

| Action | API Call | Notes |
|--------|----------|-------|
| Dismiss | `reviewReport(reportId, 'dismissed')` | Sets status = 'dismissed' |
| Warn | `reviewReport(reportId, 'warned')` | Logs warning in audit log |
| Mute in Channel | `muteInChannel(channelId, userId, duration)` + `reviewReport(reportId, 'muted')` | Only shown if channel_id present; duration selector dropdown |
| Kick from Server | `kickUser(serverId, userId, reason)` + `reviewReport(reportId, 'kicked')` | Confirmation dialog |
| Ban from Server | `banUser(serverId, userId, reason, expiresAt)` + `reviewReport(reportId, 'banned')` | Duration selector: permanent / 1h / 24h / 7d / 30d; confirmation dialog |

Each action:
1. Shows a confirmation dialog with the action description
2. Calls the appropriate store method
3. On success: navigates back to ReportQueue

### 6. AbuseSignalList Component

**File:** `src/renderer/components/moderation/AbuseSignalList.tsx`

**Props:** `{ serverId: string }`

**Features:**
- Reads `abuseSignals` from moderationStore
- Filter controls: Reviewed/Unreviewed, severity (low/medium/high/critical), signal_type
- Each row: username, signal type, severity badge (color-coded), timestamp, auto-action taken, reviewed status
- Severity colors: low (gray), medium (yellow), high (orange), critical (red)
- Click row → expand inline to show JSONB details rendered as key-value list
- "Mark Reviewed" button on each unreviewed row → calls `markAbuseSignalReviewed(signalId)`
- Clears `pendingAbuseSignalCount` when tab is selected

### 7. BanList Component

**File:** `src/renderer/components/moderation/BanList.tsx`

**Props:** `{ serverId: string }`

**Features:**
- Reads `bans` from moderationStore (filtered by serverId)
- Each row: banned user, banned by, reason, created_at, expires_at (or "Permanent")
- Expired bans shown grayed out with "Expired" badge
- Active bans first, expired bans below in separate section
- "Unban" button on each active ban → confirmation dialog → `unbanUser(serverId, userId)`
- "Add Ban" button in header → opens `AddBanDialog`:
  - User selector (text input with server member lookup)
  - Reason textarea
  - Duration selector: permanent / 1h / 24h / 7d / 30d / custom
  - Calls `banUser(serverId, userId, reason, expiresAt)`

### 8. AuditLog Component

**File:** `src/renderer/components/moderation/AuditLog.tsx`

**Props:** `{ serverId: string }`

**Features:**
- Reads `auditLog` from moderationStore
- Chronological (newest first)
- Filter controls: action type, moderator, target user, date range
- Each row: timestamp, moderator username (or "System" for automated), action type badge, target username, reason
- Action type badges with distinct colors: ban (red), kick (orange), mute (yellow), warn (blue), unban (green), dismiss (gray)
- Read-only — no edit or delete capabilities
- Pagination: "Load More" at bottom

### 9. Operator Setup Wizard

**File:** `src/renderer/components/moderation/ModerationKeySetup.tsx`

Shown when the dashboard loads and `getModerationKey(serverId)` returns empty/404.

**Steps:**

1. **Welcome screen:** "Set up moderation encryption. To decrypt report evidence, you need a moderation keypair."
   - Two buttons: "Generate New Keypair" / "Import Existing Key"

2. **Generate flow:**
   a. Post to Worker: `{ op: 'generate_moderation_keypair' }`
   b. Worker generates X25519 keypair → returns `{ publicKey, privateKey }`
   c. Upload public key to server: `PUT /servers/:id/moderation-key`
   d. Store private key in Worker's KeyStore (encrypted SQLite)
   e. Show private key backup as base64 string with copy button and warning:
      "Save this key securely. If you lose it, you will not be able to decrypt report evidence."

3. **Import flow:**
   a. Textarea for base64 private key
   b. Derive public key from private key in Worker
   c. Upload public key to server
   d. Store private key in Worker's KeyStore

### 10. Privacy Settings Integration

Verify the existing Privacy section in settings includes:
- Block list (view blocked users, unblock button)
- DM policy selector (anyone / mutual servers / nobody)

These were built in Session 3. Wire them into the settings page if not already connected.

### 11. New Crypto Worker Operations

Add to the Worker message handler:

```typescript
// Generate X25519 moderation keypair
case 'crypto:generateModerationKeypair':
  // Generate keypair using libsodium
  // Store private key in KeyStore
  // Return { publicKey: number[], privateKey: number[] }

// Decrypt report evidence
case 'crypto:decryptReportEvidence':
  // Read moderation private key from KeyStore
  // crypto_box_seal_open(evidence_blob, publicKey, privateKey)
  // Return { evidence: string } (JSON)

// Store moderation private key
case 'crypto:storeModerationPrivateKey':
  // Store in KeyStore under key 'moderation_privkey_{serverId}'

// Check if moderation key exists
case 'crypto:hasModerationKey':
  // Check KeyStore for 'moderation_privkey_{serverId}'
  // Return { hasKey: boolean }
```

Add to `cryptoService` bridge:

```typescript
generateModerationKeypair(): Promise<{ publicKey: number[], privateKey: number[] }>
decryptReportEvidence(evidenceBlob: string, serverId: string): Promise<{ evidence: string }>
storeModerationPrivateKey(serverId: string, privateKey: number[]): Promise<void>
hasModerationKey(serverId: string): Promise<{ hasKey: boolean }>
```

---

## Edge Cases

1. **No moderation key configured:** Show setup wizard instead of evidence section; metadata and actions still work
2. **Decryption failure:** Show clear error: "Could not decrypt evidence. The moderation key may be incorrect or the evidence may be corrupted."
3. **Report for deleted channel:** Show "Channel no longer exists" instead of channel name; treat as unverifiable
4. **Report for deleted user:** Show "Deleted User" placeholder; disable action buttons except dismiss
5. **Expired ban:** Show as grayed out in ban list; don't show "Unban" button
6. **Self-report:** Should be prevented server-side, but if it appears, show normally
7. **Concurrent moderators:** No locking — if two moderators review the same report, last write wins (MVP acceptable)
8. **Empty states:** Each tab shows appropriate empty state message when no data
9. **Large audit logs:** Pagination with cursor-based loading prevents loading entire history
10. **Network errors:** Show toast/inline error on failed actions, don't navigate away

---

## Acceptance Criteria

### Functional
- [ ] Shield icon appears in channel list only for owners/moderators
- [ ] Clicking shield opens moderation dashboard, replacing main content area
- [ ] Dashboard shows 4 tabs with correct notification badges
- [ ] ReportQueue shows filterable, paginated list of reports
- [ ] Clicking a report opens ReportDetail with all sections
- [ ] Evidence decryption works when operator has moderation key
- [ ] UnverifiedReportBanner shows for E2E channels, verified banner for standard
- [ ] MetadataCorroboration displays account age, report count, signals
- [ ] All 5 action buttons work (dismiss, warn, mute, kick, ban)
- [ ] AbuseSignalList shows signals, expandable details, mark reviewed
- [ ] BanList shows active/expired bans, unban works, add ban works
- [ ] AuditLog shows chronological entries with filters
- [ ] Operator setup wizard generates/imports moderation keypair
- [ ] Non-moderators cannot access the dashboard

### Tests — Vitest Unit
- [ ] ModerationDashboard: renders for owner, rejects for non-moderator
- [ ] ReportQueue: renders reports, pagination works, filters work
- [ ] ReportDetail: evidence decryption flow → plaintext displayed
- [ ] ReportDetail: E2E channel → UnverifiedReportBanner shown
- [ ] ReportDetail: standard channel → verified banner shown
- [ ] MetadataCorroboration: renders account age, report count, signals
- [ ] AbuseSignalList: renders signals, mark reviewed works
- [ ] BanList: renders bans, unban calls API
- [ ] AuditLog: renders entries, filters work
- [ ] Action buttons: each action calls correct API endpoint

### Tests — Playwright E2E
- [ ] Owner promotes moderator → moderator can access moderation dashboard
- [ ] User reports message → report appears in owner's dashboard
- [ ] Owner reviews report, bans user → user is disconnected and cannot rejoin
- [ ] User blocks another → blocked user's messages hidden
- [ ] Abuse rate limit: rapid message send → auto rate limit kicks in → user temporarily throttled

---

## File Inventory

### New Components
| File | Lines (est.) | Purpose |
|------|-------------|---------|
| `components/moderation/ModerationDashboard.tsx` | ~120 | Top-level tabbed dashboard |
| `components/moderation/ReportQueue.tsx` | ~180 | Report list with filters |
| `components/moderation/ReportDetail.tsx` | ~250 | Full report view + actions |
| `components/moderation/UnverifiedReportBanner.tsx` | ~40 | E2E evidence warning |
| `components/moderation/MetadataCorroboration.tsx` | ~100 | User metadata panel |
| `components/moderation/AbuseSignalList.tsx` | ~150 | Abuse signal viewer |
| `components/moderation/BanList.tsx` | ~180 | Ban management |
| `components/moderation/AddBanDialog.tsx` | ~120 | Ban creation dialog |
| `components/moderation/AuditLog.tsx` | ~150 | Audit log viewer |
| `components/moderation/ModerationKeySetup.tsx` | ~150 | Keypair setup wizard |
| `components/moderation/ActionConfirmDialog.tsx` | ~80 | Reusable confirmation dialog |

### Modified Files
| File | Changes |
|------|---------|
| `stores/moderationStore.ts` | Add fetchAbuseSignals, fetchBans, markAbuseSignalReviewed, activeTab, selectedReportId |
| `services/api.ts` | Add getAbuseSignals, markAbuseSignalReviewed, getReport, getUserMetadata, setModerationKey |
| `services/crypto.ts` | Add generateModerationKeypair, decryptReportEvidence, storeModerationPrivateKey, hasModerationKey |
| `types/models.ts` | Add UserModerationMetadata |
| `types/api.ts` | Add UserModerationMetadataResponse |
| `components/layout/ChannelList.tsx` | Add shield icon button for dashboard access |
| `pages/ServerPage.tsx` | Conditional render: dashboard vs normal chat |

### New Test Files
| File | Purpose |
|------|---------|
| `tests/unit/components/moderation-dashboard.test.ts` | Dashboard, report queue, report detail, signals, bans, audit log |
| `tests/e2e/flows/moderation.test.ts` | Full moderation workflow E2E |
