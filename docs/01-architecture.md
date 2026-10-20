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
│  ├─ protocol/        Signaling messages (zod schemas) + client; later the input protocol
│  ├─ desktop/         Electron main-process helpers: IPC checks, signaling bridge
│  ├─ rtc/             Shared RTCPeerConnection setup, tuning, stats, latency probe
│  ├─ crypto/          (Phase 5) Device identity, signing/verification, confirmation words
│  └─ native-input/    macOS input agent (Swift, Quartz events) + its Node wrapper
├─ server/             Signaling: session codes, relay, TURN credentials (ws + zod)
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
| **Injector** | A small Swift agent, run as a child process, that posts Quartz events. The gate first maps normalized coordinates onto the shared display and physical key codes onto macOS key codes. The agent turns moves into drags while a button is held, counts double-clicks, keeps modifier flags, finds shortcut characters on the host's keyboard layout, and lets go of everything when its input closes. |
| **Setup assistant** | First-run flow, one question per screen: welcome, pairing, Screen Recording, Accessibility, start at login, and a practice run of the consent question and session bar. Every step can be skipped; progress is saved, so the restart macOS needs after Screen Recording lands back on the same step. |
| **Menu-bar icon** | Closing the window only hides it, so helpers can still ask. The icon (a ring, with a dot while someone helps) says who is helping, and its menu has Pause/Continue, Stop, Open and Quit. Quit really quits. |

### Helper app (you)

| Module | Responsibility |
|---|---|
| **People list** | Paired hosts with online status, and a **Help** button for each. |
| **Remote view** | A `<video>` element plus input capture on top of it. Pointer Lock is not used: the local cursor is drawn immediately to keep it responsive. |
| **Input capture** | Pointer, wheel and keyboard events over the video, normalized and sent over data channels. Keys are captured and cancelled in the window, so menu shortcuts such as ⌘W act on the remote computer, not the helper app. Toolbar buttons send the combos macOS keeps for itself (⌘Tab, ⌘Space, ⌥⌘Esc). Ctrl+Alt+Del isn't possible. |
| **Session gate** | Optional Touch ID or OS password before starting a session (`systemPreferences.promptTouchID`). |

### Server (yours)

| Module | Responsibility |
|---|---|
| **WebSocket hub** | Authenticated, persistent connection per device, used for presence and for relaying **signed** messages between paired devices. |
| **Pairing API** | Issues and redeems short-lived pairing codes. Codes are stored hashed and rate-limited. |
| **TURN credentials** | Mints time-limited coturn credentials using the coturn REST-API shared secret. |
| **SQLite** | Pairings only: which host key is paired with which helper key, and since when. **No names, no IP addresses, no session records, no screen data or keystrokes.** Names stay on the devices, and session history stays on the host. |
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
 waiting ──helper joins + intro──► asking ──Yes──► connecting ──ICE ok──► live ⇄ paused
 (code)                             │ No / 60 s        │ fail              │       │
                                    ▼                  ▼                   ▼       ▼
                                  ended ◄── Stop · lock · sleep · 15 min idle · 3 h · helper leaves
```

(As built. In normal use the request is a signed request from a helper this computer pinned at pairing, checked in the host's main process before the question appears. One-time code sessions, where someone holding a code introduces themselves, remain for development and tests only.)

- **asking:** nothing is captured yet. The screen capture starts inside the "Yes" click.
- **paused:** a static "Paused" card replaces the screen through `replaceTrack`, the input gate is switched off in the main process, and the idle clock stops. Only Grandma can continue.
- Every way into **ended** stops capture, closes the peer connection, releases held keys, removes the bar and border, and writes a session-history entry if someone had asked.

## Wire protocol (data channels)

There are two channels on one RTCPeerConnection:

| Channel | Options | Carries |
|---|---|---|
| `ptr` | `ordered: false, maxRetransmits: 0` | Pointer moves only, binary, latest wins. Moves are coalesced to one per animation frame. |
| `ctl` | ordered, reliable | Everything else, as JSON validated with zod |

**Pointer move (binary, 5 bytes):** `u8 type=1 · u16 x · u16 y`, with x and y normalized to 0–65535 across the shared display. This is independent of resolution and DPI.

**Control messages (JSON, `packages/protocol/src/input.ts`):**

```ts
// helper → host
{ t: "hello",  machine: "<16 hex>" }                     // first message: which computer
{ t: "button", button: "left"|"right"|"middle", down: boolean, x, y }  // carries its position
{ t: "wheel",  dx: number, dy: number, x, y }            // pixels, clamped to ±4000
{ t: "key",    code: "KeyA", down: boolean, repeat?: boolean, char?: "a" }
{ t: "text",   text: "é" }                               // typed characters, up to 64
{ t: "release" }                                         // let go of everything
{ t: "end" }

// host → helper
{ t: "control", available: boolean, reason?: "permission"|"unsupported"|"same-computer" }
{ t: "paused",  paused: boolean }                         // only the host decides
{ t: "idle",    secondsLeft: number }                     // warning before an idle session ends
{ t: "end" }
```

Before the connection exists, two more messages travel through the signaling server: the helper's `{ kind: "intro", name }` (shown on the consent card) and the host's `{ kind: "declined", reason: "no" | "timeout" }`. Names are limited to 40 characters with no control or invisible formatting characters, so a name can't be made to display misleadingly.

Clicks and scrolls carry their own position, so they land where the helper pointed even if a pointer move on the unreliable channel was lost.

**Keyboard strategy:** typed characters (no ⌘ or Ctrl held) go as **text**, so "é" stays "é" whatever the host's layout. Shortcuts, modifiers and special keys go as **physical codes** (`code`). Shortcuts also carry the **character** the key typed on the helper's keyboard, and the host's agent looks that character up on its own layout. That way ⌘A stays ⌘A between a QWERTY helper and an AZERTY host, instead of becoming ⌘Q. Keys are captured in the helper window and cancelled there, which also keeps the helper's own menu shortcuts (⌘W, ⌘Q) from firing. (Cancelling them earlier, in Electron's `before-input-event`, makes Chromium drop the matching key-ups, which would leave keys held on the host.) A Cmd↔Ctrl toggle for Windows hosts comes with Windows support.

**Validation:** messages are checked against zod schemas twice: in the host renderer, and again in the main process before the input gate. The gate drops everything unless control is on. It never clicks, scrolls or types into the host app's own windows, accepts only keys in a fixed table (no power or media keys), and caps events at 400 per second. It releases everything on disconnect, when control is turned off, and if the window or renderer goes away.

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
