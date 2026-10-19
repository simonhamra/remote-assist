# 3. Security & Privacy

## Principles

1. **Grandma's computer is the authority.** Consent, pause, stop and input filtering are all enforced inside the host process. The helper app and the server can *ask*, never *force*.
2. **Consent every session, visible at all times.** No silent or unattended access in the MVP.
3. **Trust devices, not passwords.** Pinned public keys, established once in person or on a phone call.
4. **Don't trust the server with secrets.** It relays signed messages and never sees screen content or keystrokes.
5. **Collect almost nothing.** No recordings. Server data is limited to public keys and session timestamps.
6. **Never bypass the OS.** Work with macOS/Windows permission systems, not around them (see [OS permissions](04-os-permissions.md)).

## Identity & authentication

| Element | Design |
|---|---|
| **Device identity** | An Ed25519 keypair is generated on first launch. The private key is encrypted with Electron `safeStorage` (macOS Keychain / Windows DPAPI) and never leaves the device. |
| **Server login** | No accounts or passwords. On WebSocket connect the server sends a nonce, the device signs `nonce ‖ server-origin ‖ timestamp`, and the server checks the signature against the registered public key. |
| **Pairing (trusted devices)** | An 8-digit code shown on the host, valid for **10 min**, **single use**, **5 attempts** maximum, stored as a hash, and rate-limited per IP. Both screens then show **3 confirmation words** derived from `hash(hostKey ‖ helperKey ‖ code)`, and both people confirm they match. Each device then **pins** the other's key. |
| **Session requests** | Signed by the helper's key and including `sessionId`, `nonce`, `timestamp (±60 s)` and the recipient device ID. The host rejects anything unsigned, from an unpinned key, stale, or replayed. |
| **Media authentication** | The SDP offer and answer, which contain the DTLS certificate fingerprint, are signed by the device keys. Chromium refuses DTLS peers whose certificate does not match the fingerprint, so the encrypted stream is bound to the paired devices. |
| **Helper-side gate** | Touch ID or the OS password is required to start a session. A stolen, unlocked laptop cannot simply click "Help". |
| **Expiring session codes** | An optional **ad-hoc mode** for one-off help without pairing: an 8-digit code, valid 10 minutes, for a single session, with nothing remembered afterwards. **Off by default** on Grandma's machine, and only a paired helper can turn it on. *Phase 2 builds this code flow first, as the only way to connect until pairing exists (see below).* |
| **Revocation** | Grandma: *People who can help me → Remove*. You: remove from the helper app. Either action deletes the pinned key on that device and the relationship on the server. |
| **TURN credentials** | Time-limited HMAC credentials (coturn `use-auth-secret`) issued per session, expiring with the session cap |

### Interim state after Phase 4

Consent, the session bar, Pause and Stop, auto-end and the history are in place. **Nothing is shared until the person says yes**, and every request is recorded on their computer. What's still missing is identity: until pairing (Phase 5), a helper's name is whatever they typed, and anyone who gets a valid code can make the consent question appear. The consent card warns: "Only say yes if you are talking to … right now and you asked for help." Codes are random, single use and rate-limited, the server drops browser connections, and its logs contain no IPs or codes. Use builds from this stage with Grandma only once Phase 5 has replaced self-declared names with pinned devices.

Already in place on the input side:
- the input gate runs in the host's main process, and the helper can't bypass it;
- it never clicks or types into the host app's own windows;
- keys come from a fixed table;
- events are rate-limited;
- everything is released on disconnect;
- control turns itself off when both apps run on the same computer;
- the agent's events are tagged, and the host's own mouse and keyboard keep working while the helper is in control.

## Encryption

| Path | Protection |
|---|---|
| App ↔ server (signaling) | WSS over TLS 1.3, certificate from Caddy/Let's Encrypt |
| Video | DTLS-SRTP (AES-GCM), peer to peer. TURN relays only forward ciphertext. |
| Input | SCTP over DTLS (data channels) on the same authenticated connection |
| Keys at rest | OS keystore through `safeStorage` |
| Updates | Code-signed builds; electron-updater checks the signature before installing |

## Consent model

**Before control begins.** For each session the consent window states exactly what will happen:

> **Alex would like to help you.**
> Alex will be able to **see your screen** and **use your mouse and keyboard**.
> You can press **Stop** at any time.
>
> **[ Yes, let Alex help ]**   [ No, not now ]

- Large type (≥ 22 px), the helper's photo and name, plain words, no jargon
- No action within 60 s means the request expires, so silence is a "no"
- A **view-only** option exists in settings for anyone who wants it, but the default covers view and control because a second prompt would interrupt her

**During the session** there are no more prompts. Instead, constant gentle indicators:

- the session bar, *"Alex is helping you · Pause · Stop"*, always on top, on every Space/desktop, over full-screen apps
- a coloured border around the shared display
- the OS's own indicators (the macOS screen-recording indicator, and possibly the Windows capture border), which we never hide

**Ending a session.** Grandma can end a session at any time, and the host app enforces it:

| Trigger | Effect |
|---|---|
| **Pause** | The helper sees "Paused" and **all input is dropped**. Only Grandma can resume. |
| **Stop** (her side or yours) | The session ends. A new session needs new consent. |
| Screen locks, Mac/PC sleeps, user switch | The session ends automatically (`powerMonitor`) |
| 15 min with no helper input | The session ends, with a 60 s warning shown **only to the helper** |
| 3 h hard cap (configurable) | The session ends |

**Protecting the safety UI.** The input gate **drops injected clicks and keystrokes that target the host app's own windows** (consent window, session bar, settings). The helper can never click "Allow" for her, change the trusted-people list, or turn off safety features. Settings are also unavailable while a session is active.

## Anti-scam design

Remote-access apps are a favourite tool of "tech support" scammers who target elderly people. This design aims to make that attack fail.

| Scam tactic | Countermeasure |
|---|---|
| "Read me the number on your screen" | Pairing is **locked after the first helper**. New pairings need approval from an existing helper, who gets the request in their helper app. |
| "Install this app and give me the code" | Our app does not accept strangers. Ad-hoc codes are off by default, and only a paired helper can turn them on. |
| Talking her through clicking "Allow" | Session requests only come from **pinned** devices, so a stranger can't even trigger the consent window |
| Sneaky silent access | No unattended mode, constant indicators, and a session history she (and you) can see |
| Repeated attempts | Every pairing attempt and session request is shown to **all** paired helpers ("Someone tried to pair with Grandma's computer at 14:03") |

App copy should reinforce this. The pairing screen says in large text: *"Only do this with someone you know well. Alex will never call you out of the blue asking for this."*

## Threat model summary

| Threat | Mitigation |
|---|---|
| Phone scammer social-engineers Grandma | See [anti-scam design](#anti-scam-design) |
| Your helper device is stolen | Keys in Keychain, Touch ID gate, revocation from Grandma's side or a second helper |
| Server compromised or malicious | Signed messages, pinned keys and confirmation words. The server cannot impersonate either side or read media. It can at most deny service. |
| Network eavesdropping (café Wi-Fi) | TLS, DTLS-SRTP, DTLS data channels |
| Code brute force | Large code space, 10 min TTL, 5 attempts, IP rate limits, hashed storage, single use |
| Replay of old requests | Nonce + timestamp + recipient binding, with seen-nonce tracking |
| Helper ignores Pause | Enforced in the host before capture and injection. The helper has no override. |
| Stuck modifier keys after a crash or disconnect | The host releases all held keys and buttons on any disconnect or pause |
| Malformed or malicious input messages | zod/binary validation, ranges clamped, rate limits, fuzz tests on the parser |
| Electron renderer exploit | Sandbox, context isolation, CSP, fuses, no remote content |
| Malicious update | Signed updates over HTTPS, signature verified before install |

## Data handling

| Data | Where | Retention |
|---|---|---|
| Screen content, keystrokes | **Nowhere.** They exist only in flight between the two devices. | None |
| Private keys | Each device's OS keystore | Until revoked or the app is uninstalled |
| Public keys, display names, photo, pairings | Server SQLite | Until revoked |
| Session metadata (who, start, end, end reason) | Server + host history | 90 days |
| Server access logs (IP, timestamp) | VPS | 7-day rotation |
| Crash reports | Off by default. If enabled, local stack traces only, never screenshots. | 30 days |
