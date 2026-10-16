# 2. Technology Stack

The guiding rule: **reuse the best-tested real-time media stack (Chromium's WebRTC)** and write native code only where no portable API exists, which is input injection.

## Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** everywhere, plus a **small Rust** module | One language across apps, server and protocol. Rust only for native input. |
| Monorepo | **npm workspaces** | Shared packages (`rtc` now, `protocol`/`crypto` later) with one lockfile. Built into Node, so nothing extra to install, and Electron packaging works with npm's flat `node_modules`. |
| Desktop apps | **Electron 44** + **React 19** + **electron-vite 6** (Vite 8) | Chromium ships getDisplayMedia, hardware encode/decode, WebRTC, ICE/TURN, DTLS-SRTP, and the same behaviour on macOS and Windows. Electron 44 needs **macOS 13 or later**. |
| Screen capture | `desktopCapturer` + `session.setDisplayMediaRequestHandler` | No browser picker, and Chromium uses ScreenCaptureKit (macOS) / Windows Graphics Capture |
| Video transport | **WebRTC**, H.264 hardware first, VP8 fallback | Congestion control, packet-loss recovery and encryption built in |
| Input transport | **RTCDataChannel** (unreliable for pointer, reliable for the rest) | Same encrypted connection as the video, no extra ports |
| Input injection | **Rust + [napi-rs](https://napi.rs) + [`enigo`](https://github.com/enigo-rs/enigo)** (MIT) | Maintained, cross-platform (CGEvent / SendInput / X11+libei), small surface you control |
| Signaling | **Node.js 24 LTS + Fastify + `ws` + zod** | About 400 lines, easy to audit. Holds persistent WebSockets for presence. |
| Database | **SQLite** (`better-sqlite3`) | A single file of public keys and metadata, with trivial backups |
| NAT traversal | **coturn** (STUN + TURN, TLS on 443) with ephemeral REST-API credentials | Works through hotel and corporate firewalls. Credentials expire. |
| TLS / proxy | **Caddy** | Automatic HTTPS certificates, one config file |
| Hosting | One small VPS (~€5/mo, e.g. Hetzner/DigitalOcean) with **Docker Compose** | Signaling, TURN and TLS in one place. Screen-share traffic is about 1–4 Mbps per session. |
| Crypto | **Ed25519** via Node `crypto` / `@noble/curves`. Keys encrypted at rest with Electron **`safeStorage`** (Keychain / DPAPI). | Audited primitives, and private keys never leave the device |
| Packaging | **electron-builder** | DMG/ZIP for macOS, NSIS for Windows, auto-update feed |
| Updates | **electron-updater**, signed, installed silently on next restart | Grandma never sees an "Update available?" dialog |
| Code signing | macOS **Developer ID + notarization**. Windows **Authenticode** (Microsoft Trusted Signing or an OV cert). | Required for Gatekeeper/SmartScreen, and on macOS it keeps permission grants across updates |
| Testing | **Vitest** (units), **Playwright `_electron`** (e2e), a latency harness using `getStats()` | |

### Electron hardening (non-negotiable)

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` in every renderer
- A typed IPC allowlist through `contextBridge`. Renderers never touch keys or the injector directly.
- A strict CSP, no remote content loaded into app windows, and `setWindowOpenHandler` denying everything
- Electron **fuses**: disable `RunAsNode`, `EnableNodeCliInspectArguments` and `EnableNodeOptionsEnvironmentVariable`. Enable `OnlyLoadAppFromAsar` and `EnableEmbeddedAsarIntegrityValidation`.

## Alternatives considered

| Option | Verdict |
|---|---|
| **Tauri 2 (Rust + system WebView)** | Much smaller binaries, but WKWebView/WebView2 do not reliably provide headless `getDisplayMedia` and WebRTC for this use. You would end up writing native capture, encoding and `webrtc-rs` yourself, which is weeks of extra work. **Good v2 candidate once the protocol is stable.** |
| **Native apps (Swift + C#/.NET)** | Best OS integration but two full codebases. Not worth it for an MVP. |
| **Pure web app on Grandma's side** | Browsers can share a screen but **cannot inject input**, so remote control is impossible. (The *helper* side could become a web/PWA later.) |
| **Flutter** | `flutter_webrtc` is fine, but capture and input still need native plugins on each OS, so it gains nothing over Electron here. |
| **Custom QUIC/UDP media protocol** | Lower ceiling on latency, but you would rebuild congestion control, FEC, NAT traversal and encryption yourself. WebRTC already does all of this. |
| **`@nut-tree/nut-js`** for input | The official prebuilt packages now require a paid license. The community fork `@nut-tree-fork/nut-js` (Apache-2.0) is fine for a **quick Phase 1 spike**, but `enigo` via napi-rs gives a long-term, fully owned path. |
| **`robotjs`** | Unmaintained, with fragile native builds. Avoid. |
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
