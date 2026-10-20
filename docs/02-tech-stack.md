# 2. Technology Stack

The guiding rule: **reuse the best-tested real-time media stack (Chromium's WebRTC)** and write native code only where no portable API exists, which is input injection.

## Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** everywhere, plus a **small Swift** program | One language across apps, server and protocol. Swift only for injecting input on macOS. |
| Monorepo | **npm workspaces** | Shared packages (`rtc` now, `protocol`/`crypto` later) with one lockfile. Built into Node, so nothing extra to install, and Electron packaging works with npm's flat `node_modules`. |
| Desktop apps | **Electron 44** + **React 19** + **electron-vite 6** (Vite 8) | Chromium ships getDisplayMedia, hardware encode/decode, WebRTC, ICE/TURN, DTLS-SRTP, and the same behaviour on macOS and Windows. Electron 44 needs **macOS 13 or later**. |
| Screen capture | `desktopCapturer` + `session.setDisplayMediaRequestHandler` | No browser picker, and Chromium uses ScreenCaptureKit (macOS) / Windows Graphics Capture |
| Video transport | **WebRTC**, H.264 hardware first, VP8 fallback | Congestion control, packet-loss recovery and encryption built in |
| Input transport | **RTCDataChannel** (unreliable for pointer, reliable for the rest) | Same encrypted connection as the video, no extra ports |
| Input injection | **Swift agent using Quartz Event Services** (`packages/native-input`), run by the host app as a child process that reads JSON lines | `swiftc` comes with Xcode's Command Line Tools, so there's no extra toolchain. It's a separate process, so a crash can't take the app down, and closing its input releases every held key. It also gives direct control of drag events, click counts, modifier flags and layout-aware shortcuts. macOS only; Windows gets its own agent with the same protocol. |
| Signaling | **Node.js 24 LTS + `ws` + zod**, TypeScript run directly by Node (type stripping) | About 300 lines, easy to audit, no build step. Plain `node:http` is enough for one WebSocket path and a health check, so there's no web framework. |
| Database | **SQLite** through Node's built-in `node:sqlite` (Phase 5) | One table of pairings (two public keys and a date). No native module to build, and backing up is copying one file. |
| NAT traversal | **coturn** (STUN + TURN, TLS on 443) with ephemeral REST-API credentials | Works through hotel and corporate firewalls. Credentials expire. |
| TLS / proxy | **Caddy** | Automatic HTTPS certificates, one config file |
| Hosting | One small VPS (~€5/mo, e.g. Hetzner/DigitalOcean) with **Docker Compose** | Signaling, TURN and TLS in one place. Screen-share traffic is about 1–4 Mbps per session. |
| Crypto | **Ed25519** via Node's built-in `crypto`, in the main processes and on the server. Keys encrypted at rest with Electron **`safeStorage`** (Keychain / DPAPI). Pairing words from the BIP-39 English list (`@scure/bip39`, MIT). | Audited primitives, no extra crypto library, and private keys never leave the main process |
| Packaging | **electron-builder** | DMG/ZIP for macOS, NSIS for Windows, auto-update feed |
| Updates | **electron-updater** from a folder on your own server, signed, installed silently on quit or at a quiet moment | Grandma never sees an "Update available?" dialog, and the private repository needs no token in the app |
| Code signing | macOS **Developer ID + notarization**. Windows **Authenticode** (Microsoft Trusted Signing or an OV cert). | Required for Gatekeeper/SmartScreen, and on macOS it keeps permission grants across updates |
| Testing | **Vitest** (units), **Playwright `_electron`** (e2e), a latency harness using `getStats()` | |

### Electron hardening (non-negotiable)

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` in every renderer
- A typed IPC allowlist through `contextBridge`. Renderers never touch keys or the injector directly.
- A strict CSP, no remote content loaded into app windows, and `setWindowOpenHandler` denying everything
- Electron **fuses**: disable `RunAsNode`, `EnableNodeCliInspectArguments` and `EnableNodeOptionsEnvironmentVariable`. Enable `OnlyLoadAppFromAsar`, `EnableEmbeddedAsarIntegrityValidation` and `EnableCookieEncryption`. (Set at packaging since Phase 7.)
- The installed app ignores development and test switches (environment variables, the dev page server).

## Alternatives considered

| Option | Verdict |
|---|---|
| **Tauri 2 (Rust + system WebView)** | Much smaller binaries, but WKWebView/WebView2 do not reliably provide headless `getDisplayMedia` and WebRTC for this use. You would end up writing native capture, encoding and `webrtc-rs` yourself, which is weeks of extra work. **Good v2 candidate once the protocol is stable.** |
| **Native apps (Swift + C#/.NET)** | Best OS integration but two full codebases. Not worth it for an MVP. |
| **Pure web app on Grandma's side** | Browsers can share a screen but **cannot inject input**, so remote control is impossible. (The *helper* side could become a web/PWA later.) |
| **Flutter** | `flutter_webrtc` is fine, but capture and input still need native plugins on each OS, so it gains nothing over Electron here. |
| **Custom QUIC/UDP media protocol** | Lower ceiling on latency, but you would rebuild congestion control, FEC, NAT traversal and encryption yourself. WebRTC already does all of this. |
| **Rust + napi-rs + [`enigo`](https://github.com/enigo-rs/enigo)** for input | The original plan, and still a good cross-platform option. Set aside for macOS because it needs a Rust toolchain and per-architecture native builds for a few hundred lines that Swift handles directly. A candidate for the Windows agent. |
| **`@nut-tree/nut-js`** for input | The official prebuilt packages now require a paid license. The community fork `@nut-tree-fork/nut-js` (Apache-2.0) would do for a quick spike. |
| **`robotjs`** | Unmaintained, with fragile native builds. Avoid. |
| **Fastify** for the server | Considered for Phase 2. Unnecessary for one WebSocket endpoint and a health check. Revisit if the server grows an HTTP API. |
| **Firebase / Supabase Realtime for signaling** | Works, but a tiny server you own is easier to reason about for authentication and logging. |
| **Managed TURN** (Cloudflare Realtime TURN, Twilio, Metered) | A perfectly good substitute for coturn if you'd rather not run it. Your traffic volume is tiny. |

## Build vs. adopt

If the only goal is "help Grandma next weekend", **self-hosting [RustDesk](https://github.com/rustdesk/rustdesk)** (open source, AGPL-3.0, with its own relay server) gets you a working tool today. Building this project is worth it for:

- an **elder-first UI**: one window, one question, one big button
- a **stricter trust model**: no ad-hoc IDs or passwords for scammers to ask for, pinned devices, consent every time
- full ownership of the code, the server and the data

The middle path, forking RustDesk, gives mature capture, codecs and NAT traversal, but means customizing a large Rust + Flutter codebase and meeting AGPL obligations if you distribute it.

## Rough running costs

| Item | Cost |
|---|---|
| VPS (signaling + TURN) | ~€5/month (20 TB traffic included on typical plans) |
| Domain | ~€10/year |
| Apple Developer Program | $99/year: **required in practice if Grandma uses a Mac** (notarization, stable permission grants) |
| Windows code signing | ~$10/month (Trusted Signing) or skip at first and click through SmartScreen once during setup |

TURN bandwidth: an hour of relayed screen sharing is about 0.5–1.8 GB, so even worst-case use is far below VPS limits.
