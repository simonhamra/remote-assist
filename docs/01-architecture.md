# 1. MVP Architecture

## Goals and non-goals

**MVP goals**

- Live view of Grandma's screen with low latency: under 150 ms glass-to-glass on a direct path, under 250 ms through a relay
- Accurate remote mouse and keyboard, including text with accents, right-click, drag, scroll and common shortcuts
- After pairing, connecting takes **one click for you and one click for her**
- Consent before every session, a visible indicator during it, and Pause and Stop at any moment
- Mutual authentication of devices, with encryption that does not depend on trusting the server

**Explicit non-goals for the MVP** (each is a deliberate privacy or complexity choice)

- **Unattended access**, meaning connecting when she is not there to click Allow
- Session recording of any kind
- Controlling the login window, lock screen, or Windows UAC / admin prompts (she answers those herself)
- Linux and mobile hosts (iOS cannot be remote-controlled at all)
- Clipboard sync, file transfer and voice. These come right after the MVP (see the [plan](05-implementation-plan.md#post-mvp-backlog))

## Components

```
remote-assist/
├─ apps/
│  ├─ host/            Electron app installed on Grandma's computer
│  └─ helper/          Electron app on your desktop
├─ packages/
│  ├─ protocol/        Message types, zod schemas, binary pointer codec
│  ├─ crypto/          Device identity, signing/verification, confirmation words
│  ├─ rtc/             Shared RTCPeerConnection setup + tuning
│  └─ native-input/    Rust (napi-rs + enigo) mouse/keyboard injector
├─ server/             Signaling + pairing API (Fastify + ws + SQLite)
└─ infra/              docker-compose.yml, Caddyfile, turnserver.conf
```

### Host app (Grandma)

| Module | Responsibility |
|---|---|
| **Main process** | Owns the session state machine, the identity key and the trusted-helper list. It is the **only authority** on whether a session is active or paused. |
| **Consent window** | A full-size, large-type window that asks once per session, shows the helper's name and photo, and expires after 60 s with no action. |
| **Session bar** | A small, always-on-top window on every desktop/Space and over full-screen apps, with **Pause** and **Stop**. A thin coloured border overlay marks the shared screen. |
| **Capture** | `getDisplayMedia` through Electron's `setDisplayMediaRequestHandler`, so no Chromium picker appears. One display at a time, capped at 30 fps with resolution limited to ~1080p. |
| **Input gate** | Checks every incoming event: is the session active and not paused, is the event well-formed, is the target outside the host app's own windows? Only then does it call the injector. On pause or disconnect it releases all held keys and buttons. |
| **Injector** | Native module that maps normalized coordinates to the right display and DPI, and maps physical key codes to the OS's virtual keys. |
| **Setup assistant** | First-run flow: pairing, then the OS permissions walkthrough, then launch-at-login. |
| **Tray / menu-bar icon** | Shows status at a glance and opens a simple window: "Ask Alex for help", "People who can help me", "Session history". |

### Helper app (you)

| Module | Responsibility |
|---|---|
| **People list** | Paired hosts with online status, and a **Help** button for each. |
| **Remote view** | A `<video>` element plus input capture on top of it. Pointer Lock is not used: the local cursor is drawn immediately to keep it responsive. |
| **Input capture** | Pointer, wheel and keyboard events, normalized and sent over data channels. `before-input-event` stops shortcuts such as Cmd+W from acting on the helper app itself. A toolbar sends combos the OS keeps for itself (Cmd+Tab, Cmd+Space, Ctrl+Alt+Del is not possible). |
| **Session gate** | Optional Touch ID or OS password before starting a session (`systemPreferences.promptTouchID`). |

### Server (yours)

| Module | Responsibility |
|---|---|
| **WebSocket hub** | Authenticated, persistent connection per device, used for presence and for relaying **signed** messages between paired devices. |
| **Pairing API** | Issues and redeems short-lived pairing codes. Codes are stored hashed and rate-limited. |
| **TURN credentials** | Mints time-limited coturn credentials using the coturn REST-API shared secret. |
| **SQLite** | Device public keys, display names, pairing relationships, and session metadata (start, end, reason). **No screen data, no keystrokes.** |
| **coturn** | Relay for networks where peer-to-peer fails, roughly 10–20% of real-world cases. It only ever sees encrypted packets. |

## Flow 1: one-time pairing (trusted device)

Do this once, in person or during a phone call.

```
Grandma (host)                  Server                          You (helper)
     │  first launch: create device key, register pubkey             │
     │──────────────────────────────►│                               │
     │  "Read this number to Alex":  │                               │
     │      4827 1953   (10 min)     │                               │
     │                               │◄──── redeem code + pubkey ────│  you type it
     │◄──── helper pubkey + name ────│───── host pubkey + name ─────►│
     │                                                               │
     │  Both screens show the same 3 words, derived from             │
     │  hash(hostKey ‖ helperKey ‖ code):   apple · river · lamp     │
     │  "Does Alex see the same words?"  [ Yes ]                     │  you confirm too
     │                                                               │
     │  pin helper key locally ✔              pin host key locally ✔ │
```

- The **confirmation words** mean a compromised server cannot slip its own key in. The server can relay the pairing but cannot fake matching words on both screens.
- After the first helper is paired, the host **locks pairing**. Adding another helper requires approval from an existing helper (anti-scam, see [security](03-security-and-privacy.md#anti-scam-design)).
- **Invite link variant (post-MVP):** you send `https://assist.example/i/<token>`. If the app is installed it opens through the `remote-assist://` deep link and shows "Alex wants to be your helper. [Accept]". This is the one-click invitation. Code pairing stays as the reliable fallback.

## Flow 2: a support session

```
You (helper)                      Server                     Grandma (host)
 │ click Help (Touch ID)            │                              │
 │── session.request (signed) ─────►│─────────────────────────────►│ verify sig vs pinned key
 │                                  │                              │ show consent window
 │                                  │                              │ [Yes, let Alex help]
 │◄─────────────────────────────────│◄──── session.accept ─────────│
 │                                  │                              │ start capture, create offer
 │◄──────── offer (SDP incl. DTLS fingerprint, signed) ────────────│
 │ verify sig, set remote desc      │                              │
 │──────── answer (signed) ────────►│─────────────────────────────►│ verify sig
 │◄═════════════ ICE: direct, or via TURN relay ══════════════════►│
 │◄════════ video (DTLS-SRTP) ═════════════════════════════════════│
 │═════════ input (SCTP/DTLS data channels) ══════════════════════►│ input gate → injector
 │                                                                 │
 │   end: either side presses Stop · screen lock/sleep · 15 min idle · 3 h cap
```

**Why signing the SDP matters:** Chromium only completes the DTLS handshake when the peer's certificate matches the `a=fingerprint` in the remote description. Each side verifies that the description was signed by the pinned key of the other device, so the media and data channels are authenticated end to end. A malicious server cannot insert itself in the middle.

### Session state machine (host is authoritative)

```
 idle ──request(valid sig)──► asking ──Yes──► connecting ──ICE ok──► active ⇄ paused
   ▲                            │ No/60 s                      │fail      │      │
   └────────────────────────────┴──────────────────────────────┴──────────┴──────┘
                     Stop · lock · sleep · idle timeout · disconnect → idle
```

- **paused:** capture sends a static "Paused" frame through `replaceTrack`, and the input gate drops everything. Only Grandma can resume.
- Any transition back to **idle** stops capture, closes the peer connection, releases held keys, hides the bar and writes a session-history entry.

## Wire protocol (data channels)

There are two channels on one RTCPeerConnection:

| Channel | Options | Carries |
|---|---|---|
| `ptr` | `ordered: false, maxRetransmits: 0` | Pointer moves only, binary, latest wins. Moves are coalesced to one per animation frame. |
| `ctl` | ordered, reliable | Everything else, as JSON validated with zod |

**Pointer move (binary, 5 bytes):** `u8 type=1 · u16 x · u16 y`, with x and y normalized to 0–65535 across the shared display. This is independent of resolution and DPI.

**Control messages (JSON):**

```ts
// helper → host
{ t: "btn",   b: "left"|"right"|"middle", down: boolean }
{ t: "wheel", dx: number, dy: number }                  // pixels, clamped
{ t: "key",   code: "KeyA", key: "a", down: boolean }   // KeyboardEvent.code = physical key
{ t: "text",  s: "é" }                                  // composed/IME text, injected as unicode
{ t: "display.select", id: string }
{ t: "end" }

// host → helper
{ t: "state",    s: "active"|"paused" }
{ t: "displays", list: [{ id, name, w, h, primary }] }
{ t: "notice",   msg: "Grandma paused the session" }
```

**Keyboard strategy:** shortcuts and special keys go as **physical codes** (`code`), so Ctrl+C works on any layout. Printable text the helper types goes as **unicode text**, so the host's layout (AZERTY, QWERTZ, ...) does not scramble letters. An optional toggle maps Cmd to Ctrl when a Mac helper controls a Windows host.

**Validation:** the host rejects unknown types, out-of-range values, and anything that arrives outside `active`. Wheel deltas are clamped and key-event rates are limited.

## Latency design

| Stage | Budget | How |
|---|---|---|
| Capture | 5–16 ms | ScreenCaptureKit (macOS) / Windows Graphics Capture via Chromium |
| Encode | 5–10 ms | Hardware H.264 (VideoToolbox / Media Foundation), `contentHint = "detail"` |
| Network | 20–80 ms | P2P first, TURN on 443/TLS as fallback, servers near you both |
| Jitter buffer | 0–20 ms | `receiver.jitterBufferTarget = 0` |
| Decode + paint | 10–20 ms | Hardware decode, `<video>` with no extra canvas copies |

Tuning checklist:

- `sender.setParameters`: `degradationPreference: "maintain-resolution"` (keeps text sharp), `maxFramerate: 30`, `maxBitrate` of about 2.5–4 Mbps
- Codec preference H.264 first, with VP8 fallback (`setCodecPreferences`). Measure VP9 for screen content later.
- Downscale Retina/4K captures to ≤ 1920 px wide, plus a "Sharp text" toggle for native resolution at a lower frame rate
- The helper draws its own cursor instantly, and the host cursor in the stream confirms the real position
- Live stats overlay in the helper (Ctrl+Shift+S): RTT, fps, bitrate, path (direct/relay), decode time

## Resilience

- **ICE restart** on network change (Wi-Fi drop, VPN). The session survives brief disconnects (≤ 15 s) without asking for consent again. A longer drop ends the session.
- **Presence heartbeat** every 25 s. The helper sees "Grandma's computer is offline / asleep".
- **On disconnect** the host releases all keys and buttons, so nothing gets stuck.
- **Health report:** the host tells the helper about missing permissions ("Screen Recording was turned off"), so you can fix it on the phone.
