# Remote Assist

**Working name.** This is a lightweight remote-support app for helping a family member, starting with Grandma. It should feel like sitting next to her, and she always stays in control.

> **Status:** Phases 0–7 are built for macOS. The first time the app opens, it walks her through setup one step at a time: pairing, the two macOS permissions, starting with the computer, and a practice run. Afterwards it waits in the menu bar. You pair with her computer once, comparing three words. After that, you click **Help Grandma** and she sees a verified request with your name. Only if she says yes can you see her screen and use the mouse and keyboard. A floating bar with Pause and Stop stays on screen throughout. A small signaling server (with a TURN relay) connects the two, but it can't impersonate either side. Everything is tested locally, including against a tampering server; the server isn't deployed yet ([infra/README.md](infra/README.md)). Phase 7 adds signed installers and silent updates from your server. It is ready to run once you have an Apple Developer ID ([releases](docs/06-releases.md)). See [Run it](#run-it) and the [implementation plan](docs/05-implementation-plan.md).

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

Once, together: she presses **Pair with my helper** and reads you a number; you type it; you both check that the same three words appear on both screens.

Then, every time:

| You (helper) | Grandma (host) |
|---|---|
| Click **Help Grandma** (Touch ID) | A big window shows *"✓ Paired with this computer. Alex would like to help you. Alex will see your screen and can use your mouse and keyboard."* |
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
6. [Releases and updates](docs/06-releases.md): signing, notarizing, publishing updates, and the first install on Grandma's Mac

## Recommended stack (summary)

- **Both apps:** Electron + TypeScript + React. Chromium supplies screen capture, hardware video encoding and the full WebRTC stack.
- **Input injection:** a small Swift program (Quartz Event Services) that the host app runs in the background and feeds validated commands. It's macOS only for now; a Windows equivalent can speak the same line-based protocol.
- **Transport:** WebRTC peer-to-peer, with H.264 video and two data channels for input. Media is encrypted end to end with DTLS-SRTP.
- **Server:** Node.js + `ws` WebSocket signaling (TypeScript run directly by Node), with pairings stored in Node's built-in SQLite as pairs of public keys, and coturn for TURN, behind Caddy for automatic TLS. Docker Compose runs it on one small VPS.
- **Identity:** an Ed25519 key per device, created on first launch and stored with the OS keychain. There are no passwords. Trust comes from a one-time pairing with a code and confirmation words.

## Run it

Requires macOS 13 or later, Node.js 24 (see `.nvmrc`), and Xcode's Command Line Tools (for `swiftc`, which builds the input agent).

```bash
npm install
npm run check      # typecheck, lint, format check, unit tests
npm run e2e        # builds both apps and runs the end-to-end tests
npm run package    # installable apps in apps/*/dist (signed ad hoc unless set up for release)
```

The end-to-end tests start the signaling server and open both apps for a few seconds each. The apps share a synthetic **test screen** (`RA_FAKE_SCREEN=1`), so no Screen Recording permission is needed. One test connects directly, after first trying a wrong code. The other forces the connection through a local TURN relay. Both wait for video and measure latency.

### Try it with your real screen (one Mac)

1. In **Terminal**, start the server with `npm run dev:server`. In two more Terminal tabs, start the host with `npm run dev:host` and the helper with `npm run dev:helper`.
2. In the helper, enter your name. The host opens with its guided setup: click **Let's start**, then **Pair with my helper**: it shows an 8-digit number. In the helper, click **Pair with someone**, type the number, and check that both screens show the same three words. Click **They match** / **Yes, they match** on both. Carry on through the setup (or skip steps); it remembers where it got to if the app restarts. Start the host with `RA_SKIP_SETUP=1` in front of the command to go straight to the start screen. In development, the setup can't make the app start with the computer or restart it: both need the installed app.
3. In the helper, click **Help** next to the computer's name (Touch ID asks first, on Macs that have it). The host asks "*Your name* would like to help you", marked **✓ Paired with this computer**. Click **Yes, let … help**. Only now does screen capture start, so this is when macOS asks for Screen Recording permission. In development the request is for **Terminal**, the app that launched Electron, not for Remote Assist. Allow it in System Settings, quit both apps, start them again and repeat. Turn it off again when you're done: while it's on, anything started from Terminal can record the screen.
4. While the session runs, a floating bar at the top of the screen says who is helping, with **Pause** and **Stop**, and a red frame marks the shared screen. **Pause** hides the screen from the helper and switches off control; **Continue** brings them back. Locking the screen or putting the Mac to sleep ends the session. The host's start screen lists recent requests, including the ones you refused.
5. In the helper, click **Latency probe**. A small black-and-white strip appears at the bottom-left of your main display. The helper reads it back from the video and shows glass-to-glass latency in the stats overlay (⌘⇧S toggles the overlay).

Closing the host window doesn't quit the app: it keeps waiting in the menu bar (a small circle; a dot appears in it while someone is helping), and a request brings the window back. Its menu has **Pause** and **Stop** during a session, and **Quit Remote Assist**.

One-time code sessions (no pairing) are still there for development and tests: start both apps with `RA_ALLOW_CODE_SESSIONS=1` in front of the command.

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
