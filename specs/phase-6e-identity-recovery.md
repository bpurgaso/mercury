# Phase 6e: Device Management, Identity Verification & Account Recovery

## Problem Statement

Mercury's E2E crypto primitives (key generation, X3DH, Double Ratchet, Sender Keys) are
complete (Phases 6a–6d), but there is no way to:

1. **Prove device ownership** — Users need signed device lists so contacts can discover
   which devices to encrypt messages for, verified by the user's master signing key.
2. **Verify contact identity** — Users need safety numbers (fingerprints) to detect MITM
   attacks on the key exchange.
3. **Recover from device loss** — If a user loses their device, all key material and
   session state are lost. Recovery keys enable re-establishing identity.
4. **Back up keys** — Encrypted key backups stored server-side allow restoring onto a new
   device using the recovery key.

These are foundational to trust in the E2E encryption system.

## Proposed Solution

Implement four client-side crypto modules and wire them into the existing registration
flow. The server endpoints (PUT/GET device-list, PUT/GET/DELETE key-backup) are already
implemented in Phase 6b/6e server work (`identity.rs`, `device_lists.rs`).

### New Modules

| Module | Path | Purpose |
|--------|------|---------|
| `device-list.ts` | `src/worker/crypto/` | Create, sign, and verify device lists |
| `safety-numbers.ts` | `src/worker/crypto/` | Deterministic safety number generation |
| `recovery.ts` | `src/worker/crypto/` | BIP-39 mnemonic recovery keys + HKDF backup key derivation |
| `backup.ts` | `src/worker/crypto/` | Encrypt/decrypt key backup blobs |

### Modified Modules

| Module | Change |
|--------|--------|
| `keystore.ts` | Implement `exportBackupBlob()` and `importBackupBlob()` |
| `types.ts` | Add types for device list, safety number, backup blob |

## Goals

- Signed device lists verified by Ed25519 master verify key
- Deterministic safety numbers: same two keys → identical output regardless of caller
- Standard BIP-39 24-word mnemonic recovery keys with checksum validation
- AES-256-GCM encrypted key backup blobs stored server-side
- Round-trip backup: export → encrypt → decrypt → import → all keys match
- TOFU enforcement: first-seen master verify key is trusted; changes trigger warnings
- All modules unit-tested with Vitest

## Non-Goals

- Multi-device registration flow (future phase — we build the primitives here)
- Key rotation/revocation protocol (future phase)
- Safety number QR code scanning (future phase)
- UI integration beyond type definitions and worker messages (separate ticket)
- Server-side changes (already complete)

## Detailed Design

### 1. Signed Device List (`device-list.ts`)

**Data Structure:**

```typescript
interface DeviceListEntry {
  device_id: string
  identity_key: string  // base64-encoded Ed25519 public key
}

interface DeviceListPayload {
  devices: DeviceListEntry[]
  timestamp: number  // Unix ms
}

interface SignedDeviceList {
  signed_list: Uint8Array  // UTF-8 JSON of DeviceListPayload
  signature: Uint8Array    // Ed25519 detached signature over signed_list
}
```

**`createSignedDeviceList(masterKeyPair, devices)`**

1. Build `DeviceListPayload` with current timestamp
2. Serialize to canonical JSON (keys sorted: `devices` then `timestamp`)
3. `signed_list` = UTF-8 encode of JSON string
4. `signature` = Ed25519 detached sign(`signed_list`, masterKeyPair.privateKey)
5. Return `{ signed_list, signature }`

**`verifySignedDeviceList(masterVerifyPublicKey, signedList, signature)`**

1. Verify Ed25519 signature over `signed_list` using `masterVerifyPublicKey`
2. If invalid → throw `DeviceListSignatureError`
3. Parse JSON from `signed_list`
4. Validate structure: `devices` array of `{device_id, identity_key}`, `timestamp` is number
5. Return parsed `DeviceListPayload`

**Server Interaction:**

- `uploadDeviceList(signedDeviceList, masterVerifyPublicKey)` — PUT `/users/me/device-list`
  with base64-encoded `signed_list`, `master_verify_key`, and `signature`
- `fetchDeviceList(userId)` — GET `/users/{userId}/device-list`, verify signature, return
  parsed device list

**TOFU Store:**

Add a `trusted_identities` table to KeyStore:

```sql
CREATE TABLE IF NOT EXISTS trusted_identities (
  user_id TEXT PRIMARY KEY,
  master_verify_key BLOB NOT NULL,
  first_seen_at INTEGER NOT NULL
);
```

- `storeTrustedIdentity(userId, masterVerifyKey)` — Insert on first encounter
- `getTrustedIdentity(userId)` → stored key or null
- `verifyTrustedIdentity(userId, masterVerifyKey)` →
  - Not seen before: store and return `{ trusted: true, firstSeen: true }`
  - Same key: return `{ trusted: true, firstSeen: false }`
  - Different key: return `{ trusted: false, previousKey, newKey }` (caller decides)

### 2. Safety Numbers (`safety-numbers.ts`)

**Algorithm:**

1. Take two Ed25519 public keys (32 bytes each)
2. Sort lexicographically (compare byte-by-byte)
3. Concatenate: `sortedKey1 || sortedKey2` (64 bytes)
4. SHA-256 hash the concatenation → 32 bytes
5. Interpret hash as big-endian integer, format as groups of 5 decimal digits

**`generateSafetyNumber(ourIdentityKey, theirIdentityKey)`**

1. Sort the two 32-byte public keys lexicographically
2. `hash = SHA-256(key_lower || key_higher)`
3. Convert to 12 groups of 5 digits (60 digits total, from 32 bytes of hash)
4. Return as `string` of 12 groups separated by spaces

**Digit Encoding:**

Take hash bytes in 5-byte chunks (6 chunks from 30 bytes, leaving 2 bytes unused).
For each 5-byte chunk, interpret as big-endian number mod 100000 → 5-digit group.
Repeat: take the remaining 2 bytes + re-hash to get 6 more groups (or simpler: use
two rounds of SHA-256 to get enough material for 12 groups).

Simpler approach: SHA-256 the concatenation twice with different domain separators to
get 64 bytes total. Use first 60 bytes: each 5-byte chunk → `BigInt mod 100000n` →
zero-pad to 5 digits. 12 groups of 5 = 60 digits.

**`formatSafetyNumber(safetyNumber)`**

Format as: `"12345 67890 12345 67890 12345 67890 12345 67890 12345 67890 12345 67890"`

**Determinism Guarantee:**

Since we sort the two keys before hashing, both Alice computing `safety(alice, bob)` and
Bob computing `safety(bob, alice)` produce the same result.

### 3. Recovery Key (`recovery.ts`)

**BIP-39 Mnemonic Encoding:**

The standard BIP-39 English wordlist has exactly 2048 words (11 bits each).
For 256-bit entropy: 256 / 11 = 23.27, so we need a checksum to round up.
BIP-39 standard: checksum = first `entropy_bits / 32` bits of SHA-256(entropy).
For 256 bits: 8-bit checksum → 264 bits total → 24 words.

**`generateRecoveryKey()`**

1. Generate 32 bytes (256 bits) of cryptographic randomness via `sodium.randombytes_buf(32)`
2. Return as `Uint8Array`

**`encodeMnemonic(entropy)`**

1. Validate: must be exactly 32 bytes
2. Compute SHA-256 checksum of entropy → take first 8 bits (first byte)
3. Concatenate: `entropy (256 bits) || checksum (8 bits)` = 264 bits
4. Split into 24 groups of 11 bits
5. Each 11-bit group → index into BIP-39 English wordlist
6. Return array of 24 words

**`decodeMnemonic(words)`**

1. Validate: must be exactly 24 words
2. Look up each word in BIP-39 wordlist → 11-bit index
3. If any word not found → throw `InvalidMnemonicError("Unknown word: <word>")`
4. Reassemble 264 bits → extract 256-bit entropy + 8-bit checksum
5. Recompute SHA-256 checksum of entropy → compare first byte
6. If mismatch → throw `InvalidMnemonicError("Invalid checksum")`
7. Return 32-byte entropy as `Uint8Array`

**`deriveBackupEncryptionKey(recoveryKey, salt)`**

1. `HKDF-SHA256(ikm=recoveryKey, salt=salt, info="mercury-backup-v1", length=32)`
2. Return 32-byte key

**BIP-39 Wordlist:**

Embed the standard 2048-word English wordlist directly in the module as a constant
array. This avoids adding a dependency and ensures the wordlist is always available.
The wordlist is ~16KB — small enough to embed. Source: BIP-39 specification.

### 4. Key Backup (`backup.ts`)

**Backup Blob Format:**

Use MessagePack for compact binary serialization of the restorable state.

```typescript
interface BackupContents {
  version: 1
  master_verify_key: {
    public_key: Uint8Array   // 32 bytes
    private_key: Uint8Array  // 64 bytes
  }
  device_identity_key: {
    device_id: string
    public_key: Uint8Array   // 32 bytes
    private_key: Uint8Array  // 64 bytes
  }
  signed_pre_key: {
    key_id: number
    public_key: Uint8Array   // 32 bytes
    private_key: Uint8Array  // 32 bytes
    signature: Uint8Array    // 64 bytes
    timestamp: number
  }
  sessions: Array<{
    user_id: string
    device_id: string
    state: Uint8Array
  }>
  sender_keys: Array<{
    channel_id: string
    user_id: string
    device_id: string
    key_data: Uint8Array
  }>
}
```

**`createBackupBlob(keyStore, recoveryKey)`**

1. Export state from KeyStore:
   - Master verify keypair
   - Device identity keypair + device ID
   - Current signed pre-key
   - All sessions (iterate all user/device pairs)
   - All sender keys
2. Serialize with MessagePack → plaintext blob
3. Generate random 32-byte salt
4. `backupKey = deriveBackupEncryptionKey(recoveryKey, salt)`
5. Encrypt with AES-256-GCM:
   - Generate random 12-byte nonce
   - `ciphertext || tag = AES-256-GCM(backupKey, nonce, plaintext)`
   - Format: `nonce (12 bytes) || ciphertext || tag (16 bytes)`
6. Zero plaintext, backupKey from memory
7. Return `{ encrypted_backup: Uint8Array, salt: Uint8Array }`

**`restoreFromBackup(encryptedBackup, salt, recoveryKey, keyStore)`**

1. `backupKey = deriveBackupEncryptionKey(recoveryKey, salt)`
2. Extract nonce (first 12 bytes), ciphertext+tag (remainder)
3. AES-256-GCM decrypt → if auth fails, throw `BackupDecryptionError`
4. Deserialize MessagePack → `BackupContents`
5. Validate version field
6. Import into KeyStore:
   - `storeMasterVerifyKeyPair()`
   - `storeDeviceIdentityKeyPair()`
   - `storeSignedPreKey()`
   - `storeSession()` for each session
   - `storeSenderKey()` for each sender key
7. Zero backupKey, plaintext from memory
8. Return success

**AES-256-GCM via Node.js `crypto` module:**

Use `createCipheriv('aes-256-gcm', key, nonce)` and `createDecipheriv('aes-256-gcm', key, nonce)` — available in worker threads.

**Server Interaction:**

- `uploadKeyBackup(encryptedBackup, salt)` — PUT `/users/me/key-backup`
  with base64-encoded `encrypted_backup` and `key_derivation_salt`
- `downloadKeyBackup()` — GET `/users/me/key-backup`, return
  `{ encrypted_backup, salt, backup_version }`

### 5. KeyStore Changes

**New Table:**

```sql
CREATE TABLE IF NOT EXISTS trusted_identities (
  user_id TEXT PRIMARY KEY,
  master_verify_key BLOB NOT NULL,
  first_seen_at INTEGER NOT NULL
);
```

**`exportBackupBlob()`** — Returns serialized state (MessagePack):

1. Read master verify keypair
2. Read device identity keypair + device ID
3. Read current signed pre-key
4. Read all sessions (query all rows from sessions table)
5. Read all sender keys (query all rows from sender_keys table)
6. Serialize with MessagePack
7. Return as `Uint8Array`

**`importBackupBlob(blob)`** — Restores state from MessagePack:

1. Deserialize blob
2. Store master verify keypair
3. Store device identity keypair
4. Store signed pre-key
5. Store all sessions (in transaction)
6. Store all sender keys (in transaction)

**TOFU Methods:**

- `storeTrustedIdentity(userId, masterVerifyKey)`
- `getTrustedIdentity(userId)` → `Uint8Array | null`

## Edge Cases

1. **Tampered device list** — Signature verification fails → `DeviceListSignatureError`.
   Caller must not use the device list for encryption.

2. **Tampered signature** — Same as above. Corrupted signature bytes → verify returns false.

3. **Master verify key change (TOFU violation)** — `verifyTrustedIdentity()` returns
   `{ trusted: false }`. UI must display warning: "User X's identity has changed."
   Do NOT silently accept. User must explicitly acknowledge before proceeding.

4. **Invalid mnemonic — wrong word count** — `decodeMnemonic()` throws immediately with
   `"Expected 24 words, got N"`.

5. **Invalid mnemonic — unknown word** — `decodeMnemonic()` throws with
   `"Unknown word: <word>"`.

6. **Invalid mnemonic — bad checksum** — `decodeMnemonic()` throws with
   `"Invalid checksum"`. This catches typos in recovery key.

7. **Wrong recovery key for backup** — AES-256-GCM decryption produces authentication
   failure. `restoreFromBackup()` throws `BackupDecryptionError`.

8. **Corrupted backup blob** — AES-256-GCM authentication catches any tampering.
   MessagePack deserialization also validates structure.

9. **Empty device list** — Valid: a user with no active devices has an empty list.
   The list is still signed and valid.

10. **Safety number with self** — Should work (degenerate case, same key twice).
    Both copies sort to the same position, hash is deterministic.

## Acceptance Criteria

### Device List
- [ ] `createSignedDeviceList()` produces a signed device list verifiable by the master key
- [ ] `verifySignedDeviceList()` returns parsed payload on valid signature
- [ ] `verifySignedDeviceList()` throws on tampered list content
- [ ] `verifySignedDeviceList()` throws on tampered signature
- [ ] Upload to PUT `/users/me/device-list` with correct wire format
- [ ] Fetch and verify other users' device lists via GET `/users/{userId}/device-list`
- [ ] TOFU: first-seen identity stored, same key accepted, different key rejected

### Safety Numbers
- [ ] `generateSafetyNumber(A, B)` equals `generateSafetyNumber(B, A)` (order-independent)
- [ ] Different key pairs produce different safety numbers
- [ ] Output is 12 groups of 5 digits separated by spaces (60 digits total)
- [ ] Deterministic: same inputs always produce same output

### Recovery Key
- [ ] `generateRecoveryKey()` returns 32 bytes of randomness
- [ ] `encodeMnemonic()` produces exactly 24 words from the BIP-39 English wordlist
- [ ] `decodeMnemonic(encodeMnemonic(entropy))` round-trips to identical bytes
- [ ] `decodeMnemonic()` rejects wrong word count
- [ ] `decodeMnemonic()` rejects unknown words
- [ ] `decodeMnemonic()` rejects invalid checksum

### Key Backup
- [ ] `createBackupBlob()` → encrypt → `restoreFromBackup()` → all keys match originals
- [ ] Wrong recovery key → `BackupDecryptionError`
- [ ] All key types are backed up: master verify, device identity, signed pre-key, sessions, sender keys
- [ ] Backup format includes version field for future compatibility

### TOFU
- [ ] First device list for user → accepted, key stored
- [ ] Same master verify key, updated device list → accepted
- [ ] Different master verify key → rejected with identity change result
