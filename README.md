# Remote Assist

**Working name.** This is a lightweight remote-support app for helping a family member, starting with Grandma. It should feel like sitting next to her, and she always stays in control.

> **Status:** Phase 0 (foundations) and Phase 1 (screen-streaming spike) are built for macOS. The host shares its screen with the helper over WebRTC, using copy-paste codes; there is no server yet. See [Run it](#run-it) and the [implementation plan](docs/05-implementation-plan.md).

## The idea in one picture

```
 Grandma's computer                                  Your desktop
┌─────────────────────────────┐                    ┌─────────────────────────────┐
│  HOST APP  (Electron)       │                    │  HELPER APP  (Electron)     │
│                             │   WebRTC, P2P      │                             │
│  Consent screen + Stop bar  │   DTLS-SRTP        │  "Help Grandma" button      │
│  Screen capture ────────────┼──── video ────────►│  Live view of her screen    │
│  Input gate → injector ◄────┼──── mouse/keys ────┤  Mouse + keyboard capture   │
│  Device key (pinned peers)  │   (data channels)  │  Device key (Touch ID gate) │
└──────────────┬──────────────┘                    └──────────────┬──────────────┘
               │  WSS: presence + signed signaling                │
               └────────────►┌──────────────────────┐◄────────────┘
                             │  YOUR SMALL SERVER   │
                             │  Signaling (Node.js) │   never sees the screen,
                             │  SQLite: keys + meta │   only relays signed
                             │  coturn (TURN relay) │   handshake messages
                             └──────────────────────┘
```

## How a session feels

| You (helper) | Grandma (host) |
|---|---|
| Click **Help Grandma** (Touch ID) | A big window shows your photo: *"Alex would like to help you. Alex will see your screen and can move your mouse."* |
| | She clicks **Yes, let Alex help** (the only click she needs) |
| Her screen appears within ~2–5 s, and you can use the mouse and keyboard | A slim bar shows *"Alex is helping you · Pause · Stop"* and a coloured border appears around her screen |
| | **Pause** freezes your view and blocks your input. **Stop** ends the session, and so does locking or sleeping the computer |

After a one-time setup, the session itself raises **no OS permission prompts**. On macOS there is one caveat, covered in [OS permissions](docs/04-os-permissions.md).

## Documents

1. [Architecture](docs/01-architecture.md): components, session and pairing flows, wire protocol, latency design
2. [Technology stack](docs/02-tech-stack.md): what to use, why, and what was rejected
3. [Security & privacy](docs/03-security-and-privacy.md): threat model, authentication, consent model, data handling
4. [OS permissions](docs/04-os-permissions.md): what each OS requires and how to keep prompts to a minimum without bypassing any
5. [Implementation plan](docs/05-implementation-plan.md): phased steps with exit criteria, plus the post-MVP backlog

## Recommended stack (summary)

- **Both apps:** Electron + TypeScript + React. Chromium supplies screen capture, hardware video encoding and the full WebRTC stack.
- **Input injection:** a small Rust native module (napi-rs + [`enigo`](https://github.com/enigo-rs/enigo)) that runs inside the host app.
- **Transport:** WebRTC peer-to-peer, with H.264 video and two data channels for input. Media is encrypted end to end with DTLS-SRTP.
- **Server:** Node.js + Fastify + WebSocket signaling, SQLite, and coturn for TURN, behind Caddy for automatic TLS. Docker Compose runs it on one small VPS.
- **Identity:** an Ed25519 key per device, created on first launch and stored with the OS keychain. There are no passwords. Trust comes from a one-time pairing with a code and confirmation words.

## Run it

Requires macOS 13 or later and Node.js 24 (see `.nvmrc`).

```bash
npm install
npm run check      # typecheck, lint, format check, unit tests
npm run e2e        # builds both apps and runs the end-to-end test
```

The end-to-end test opens both apps for a few seconds. They share a synthetic **test screen** (`RA_FAKE_SCREEN=1`), so no Screen Recording permission is needed. The test swaps the codes, waits for video, and measures latency.

### Try it with your real screen (one Mac)

1. In **Terminal**, start the host with `npm run dev:host`. In a second Terminal tab, start the helper with `npm run dev:helper`.
2. In the host window, click **Start sharing my screen**. macOS asks for Screen Recording permission. In development, the request is for **Terminal**, the app that launched Electron, not for Remote Assist. Allow it in System Settings, quit both apps, and start them again. Turn it off again when you're done: while it's on, anything started from Terminal can record the screen.
3. Copy the invite code into the helper, click **Connect**, then copy the reply code back into the host.
4. In the helper, click **Latency probe**. A small black-and-white strip appears at the bottom-left of your main display. The helper reads it back from the video and shows glass-to-glass latency in the stats overlay (⌘⇧S toggles the overlay).

**Between two Macs:** run the host on one Mac and the helper on the other, both on the same network, and send the codes by Messages or email. There's no STUN/TURN server yet (that's Phase 2), so different networks won't connect. macOS 15+ may ask for **Local Network** access the first time. That prompt is expected, and the plan says to test for it.

### Measured so far (this Mac, test screen)

| Measure | Result | Phase 1 target |
|---|---|---|
| Glass-to-glass latency | **40 ms** median, 58 ms p95 | < 100 ms |
| Resolution | 1920 × 1080, H.264 | 1080p |
| Path | direct, host ↔ host UDP | — |
| Host app CPU | ~2% of one core | < 25% |

The test screen skips real capture, so measure with your real screen (steps above) and on a Mac as old as Grandma's before calling Phase 1 done.

## Open decisions

1. **Grandma's macOS version.** Electron 44 needs **macOS 13 (Ventura) or later**. If her Mac runs macOS 12 or earlier, we pin Electron 43 or plan an OS upgrade.
2. **Voice:** use a normal phone call during sessions for now, or build voice chat in from the start? Voice is cheap to add but brings a microphone permission.
3. **Hosting:** a €5/month VPS (recommended), or managed services (Cloudflare Workers + Cloudflare TURN)? Needed for Phase 2.
4. **Build vs. adopt:** this plan builds a focused app. If you only need something working this week, self-hosting [RustDesk](https://github.com/rustdesk/rustdesk) is the fastest route (see [tech stack](docs/02-tech-stack.md#build-vs-adopt)).
