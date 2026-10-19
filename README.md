# Remote Assist

**Working name.** This is a lightweight remote-support app for helping a family member, starting with Grandma. It should feel like sitting next to her, and she always stays in control.

> **Status:** Phases 0–4 are built for macOS. The host shares its screen and, once the person says yes on a consent screen, the helper can see it and use the mouse and keyboard. A floating bar with Pause and Stop stays on screen throughout. A small signaling server matches the two with an 8-digit code, and a TURN relay covers networks where a direct connection fails. Everything is tested locally; the server isn't deployed yet ([infra/README.md](infra/README.md)). The helper's name isn't verified until trusted pairing (Phase 5), so these are still testing builds. See [Run it](#run-it) and the [implementation plan](docs/05-implementation-plan.md).

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
                             │  (no database yet)   │   only relays the
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
- **Input injection:** a small Swift program (Quartz Event Services) that the host app runs in the background and feeds validated commands. It's macOS only for now; a Windows equivalent can speak the same line-based protocol.
- **Transport:** WebRTC peer-to-peer, with H.264 video and two data channels for input. Media is encrypted end to end with DTLS-SRTP.
- **Server:** Node.js + `ws` WebSocket signaling (TypeScript run directly by Node) and coturn for TURN, behind Caddy for automatic TLS. Docker Compose runs it on one small VPS. SQLite arrives once there's something to keep (session history, pairings).
- **Identity:** an Ed25519 key per device, created on first launch and stored with the OS keychain. There are no passwords. Trust comes from a one-time pairing with a code and confirmation words.

## Run it

Requires macOS 13 or later, Node.js 24 (see `.nvmrc`), and Xcode's Command Line Tools (for `swiftc`, which builds the input agent).

```bash
npm install
npm run check      # typecheck, lint, format check, unit tests
npm run e2e        # builds both apps and runs the end-to-end tests
```

The end-to-end tests start the signaling server and open both apps for a few seconds each. The apps share a synthetic **test screen** (`RA_FAKE_SCREEN=1`), so no Screen Recording permission is needed. One test connects directly, after first trying a wrong code. The other forces the connection through a local TURN relay. Both wait for video and measure latency.

### Try it with your real screen (one Mac)

1. In **Terminal**, start the server with `npm run dev:server`. In two more Terminal tabs, start the host with `npm run dev:host` and the helper with `npm run dev:helper`.
2. In the host window, click **Get help from someone**. It shows an 8-digit number. In the helper, enter your name and that number, then click **Connect**.
3. The host asks "*Your name* would like to help you". Click **Yes, let … help**. Only now does screen capture start, so this is when macOS asks for Screen Recording permission. In development the request is for **Terminal**, the app that launched Electron, not for Remote Assist. Allow it in System Settings, quit both apps, start them again and repeat. Turn it off again when you're done: while it's on, anything started from Terminal can record the screen.
4. While the session runs, a floating bar at the top of the screen says who is helping, with **Pause** and **Stop**, and a red frame marks the shared screen. **Pause** hides the screen from the helper and switches off control; **Continue** brings them back. Locking the screen or putting the Mac to sleep ends the session. The host's start screen lists recent requests, including the ones you refused.
5. In the helper, click **Latency probe**. A small black-and-white strip appears at the bottom-left of your main display. The helper reads it back from the video and shows glass-to-glass latency in the stats overlay (⌘⇧S toggles the overlay).

On one Mac, mouse and keyboard control switches itself off: the helper would only be controlling its own screen. Try control between two Macs instead (below).

**Between two Macs on the same network:** on the Mac that runs the server, start it with `HOST=0.0.0.0 npm run dev:server` so the other Mac can reach it. On both Macs, start the app with `RA_SIGNALING_URL=ws://<that Mac's IP>:8787/ws` in front of the command, for example `RA_SIGNALING_URL=ws://192.168.1.20:8787/ws npm run dev:helper`. macOS 15+ may ask for **Local Network** access the first time. That prompt is expected, and the plan says to test for it.

To control the host Mac, its app needs **Accessibility** permission. Once connected, the host window shows **Open System Settings**; switch on the app listed there (in development, Terminal again). It takes effect straight away, with no restart. In the helper, **Control** in the toolbar turns control on and off. The **⌘ Tab**, **⌘ Space** and **⌥⌘ Esc** buttons send the shortcuts macOS keeps for itself. While you're controlling, every key goes to the other Mac, including ⌘W and ⌘Q. Use **Disconnect** to stop.

Things to check by hand on a real Mac, since the tests can't post real events: scrolling goes the expected way, double-clicks open things, and on the host keyboard layout "Crème brûlée" comes out as typed.

**Across the internet:** deploy the server first ([infra/README.md](infra/README.md)), then use `RA_SIGNALING_URL=wss://your-domain/ws`.

### Measured so far (this Mac, test screen)

| Measure | Direct | Through the TURN relay | Target |
|---|---|---|---|
| Glass-to-glass latency | **38 ms** median, 57 ms p95 | **42 ms** median, 59 ms p95 | < 100 ms direct, < 250 ms relayed |
| Resolution | 1920 × 1080, H.264 | 1920 × 1080, H.264 | 1080p |
| Host app CPU | ~2% of one core | ~2% of one core | < 25% |

Both apps and the relay run on one Mac here, so these numbers leave out real network distance. The test screen also skips real capture. Measure with your real screen (steps above), on a Mac as old as Grandma's, and through the deployed server before calling these phases done.

## Open decisions

1. **Grandma's macOS version.** Electron 44 needs **macOS 13 (Ventura) or later**. If her Mac runs macOS 12 or earlier, we pin Electron 43 or plan an OS upgrade.
2. **Voice:** use a normal phone call during sessions for now, or build voice chat in from the start? Voice is cheap to add but brings a microphone permission.
3. **Hosting:** the deploy files target a €5/month VPS with your own domain ([infra/README.md](infra/README.md)). This is needed before testing across different networks.
4. **Build vs. adopt:** this plan builds a focused app. If you only need something working this week, self-hosting [RustDesk](https://github.com/rustdesk/rustdesk) is the fastest route (see [tech stack](docs/02-tech-stack.md#build-vs-adopt)).
