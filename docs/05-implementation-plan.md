# 5. Implementation Plan

The phases are ordered so that **the riskiest unknowns (latency, injection, permissions) are proven first**, and security and polish are layered onto a working pipe. Effort is given in focused developer-days and is approximate.

| Phase | Outcome | Effort |
|---|---|---|
| 0 | Repo, tooling, accounts | 1–2 d |
| 1 | Her screen appears on your desktop (LAN) | 2–3 d |
| 2 | Works across the internet | 3–4 d |
| 3 | You can control her mouse and keyboard | 4–6 d |
| 4 | Consent, Pause, Stop, enforced by the host | 3–4 d |
| 5 | Trusted-device pairing and signed sessions | 4–5 d |
| 6 | Grandma-proof setup and UI | 3–4 d |
| 7 | Signed installers and silent updates | 2–4 d |
| 8 | Hardening and a real-world trial | 3–5 d |
| | **MVP total** | **≈ 25–37 dev-days** |

---

## Phase 0: Foundations

- [x] npm workspaces monorepo: `apps/host`, `apps/helper`, `packages/rtc`. The other packages (`protocol`, `crypto`, `native-input`), `server` and `infra` are added in the phase that needs them.
- [x] TypeScript strict, ESLint, Prettier, Vitest, and GitHub Actions CI (checks on macOS and Windows runners, end-to-end test on macOS). The CI file is written but hasn't run yet because the repo has no GitHub remote.
- [x] electron-vite scaffolds for both apps, with the hardening defaults from the [stack doc](02-tech-stack.md#electron-hardening-non-negotiable) applied from day one: sandbox, context isolation, IPC sender checks, strict CSP, no new windows or navigation, and a permission allowlist. Electron fuses are set at packaging time (Phase 7).
- [ ] **Start the slow external tasks now (you):** Apple Developer Program enrollment, the Persistent Content Capture entitlement request, a domain, and a VPS
- [x] Decide the first target OS based on Grandma's computer: **macOS**

**Exit:** `npm run dev:host` and `npm run dev:helper` launch both apps, and `npm run check` passes. ✅ Locally; CI waits for a GitHub repo.

## Phase 1: Screen-streaming spike

- [x] Host: `setDisplayMediaRequestHandler` captures the primary display with no picker, and only for the app's own window right after a click
- [x] Both apps: RTCPeerConnection with **copy-paste signaling** (compressed `RA1.` codes, no server yet)
- [x] Helper: `<video>` view, plus a stats overlay (path, RTT, fps, bitrate, codec, decoder, decode time, jitter buffer) and a **latency probe** that measures glass-to-glass latency on one Mac
- [x] Apply the tuning: `contentHint`, `degradationPreference`, bitrate and fps caps, H.264 preference, `jitterBufferTarget = 0`
- [ ] Measure with the real screen, and on hardware **as old as Grandma's** (steps in the [README](../README.md#try-it-with-your-real-screen-one-mac))

**Exit:** 1080p at ~30 fps, < 100 ms glass-to-glass on LAN, < 25% CPU on the host machine.

**Results so far** (end-to-end test on an Apple M2 Mac running macOS 13.5, synthetic test screen): 1920 × 1080 H.264 over a direct path, **40 ms** median and 58 ms p95 glass-to-glass, host app at ~2% of one core. Real screen capture and older hardware are still to be measured.

## Phase 2: Signaling server and TURN

- [ ] Fastify + `ws` server: device registration (public key), challenge-response login, presence, and relaying messages between paired devices
- [ ] SQLite schema: `devices`, `pairings`, `pairing_codes`, `sessions`
- [ ] coturn with `use-auth-secret`, TLS on 443, and a `/turn-credentials` endpoint
- [ ] `infra/docker-compose.yml`: Caddy, signaling and coturn, plus a nightly SQLite backup
- [ ] Apps fetch ICE servers from the server and use ICE restart on network change

**Exit:** connects host ↔ helper on two different networks (home Wi-Fi ↔ phone hotspot), and connects with `iceTransportPolicy: "relay"` forced (proving TURN works).

## Phase 3: Remote input

- [ ] `packages/native-input`: napi-rs wrapper around `enigo`, with `moveAbs`, `button`, `scroll`, `key`, `text` and `releaseAll`
- [ ] `packages/protocol`: binary pointer codec, zod schemas for control messages, fuzz tests
- [ ] Coordinate mapping: normalized → display bounds → DPI scale. Multi-display aware, with a display switcher.
- [ ] Keyboard: physical `code` → virtual key for shortcuts, unicode `text` for printable characters, an optional Cmd↔Ctrl mapping, and toolbar combos
- [ ] Helper: capture pointer/wheel/keys on the video. `before-input-event` stops local shortcuts. The local cursor is drawn.
- [ ] Input gate: state check, rate limits, clamps, and **releaseAll on pause or disconnect**
- [ ] (Optional shortcut: prototype with `@nut-tree-fork/nut-js` first, then swap in the Rust module)

**Exit:** from your desktop you can open apps, type "Crème brûlée" correctly on her layout, right-click, drag a file, scroll a web page, and use Cmd/Ctrl+C/V. Killing the helper mid-drag leaves no stuck button or key.

## Phase 4: Consent and session safety

- [ ] Host session state machine (`idle → asking → connecting → active ⇄ paused`) as a tested pure module
- [ ] Consent window (large type, helper photo, 60 s expiry, "No" by default on timeout)
- [ ] Session bar (always on top, all Spaces/desktops, over full-screen apps) and border overlay
- [ ] Pause (`replaceTrack` with a "Paused" frame, all input dropped) and Stop (from either side)
- [ ] Auto-end on screen lock, sleep or user switch (`powerMonitor`), 15 min idle, and the 3 h cap
- [ ] Input gate drops events targeting the host app's own windows, and settings are locked during a session
- [ ] Session history (host UI + server metadata)

**Exit:** a scripted "malicious helper" test (keeps sending input after Pause, clicks the consent and bar areas, floods events) produces **zero** injected events.

## Phase 5: Pairing and trusted devices

- [ ] `packages/crypto`: Ed25519 keygen, sign/verify, confirmation words (a 2048-word list → 3 words ≈ 33 bits)
- [ ] Keys at rest through `safeStorage`
- [ ] Pairing: 8-digit code (hashed, 10 min TTL, 5 attempts, single use) → key exchange → 3-word confirmation on both screens → pin
- [ ] Signed `session.request`, offer and answer (nonce, timestamp, recipient). Reject unsigned, stale, replayed, or unpinned.
- [ ] Pairing lock after the first helper. Additional helpers need approval from an existing helper. Pairing attempts are reported to all helpers.
- [ ] Revocation from both sides. Helper Touch ID / OS-auth gate before a session.
- [ ] Ad-hoc expiring session codes (off by default, enabled only by a paired helper)

**Exit:** with a tampering proxy in front of the server (modified SDP, swapped keys, replayed requests), every session **fails closed**. Expired, reused and brute-forced codes are rejected.

## Phase 6: Grandma-proof setup and UX

- [ ] Setup assistant (see the [permissions doc](04-os-permissions.md#setup-assistant-host-first-run-target-10-minutes-on-the-phone)): pre-permission screens, deep links, grant detection, auto-relaunch
- [ ] Launch at login, plus a tray/menu-bar icon with three items at most
- [ ] Permission health check at launch, reported to the helper
- [ ] UI pass: ≥ 22 px type, WCAG AAA contrast, ≥ 64 px buttons, one question per screen, the same wording every time, VoiceOver/Narrator labels
- [ ] Optional soft chime at session start and end
- [ ] Copy review: no jargon ("host", "session", "connection" become "Alex is helping you")

**Exit:** a non-technical tester (ideally someone Grandma's age) completes setup with phone guidance in **< 10 min**, and a normal session needs **one click** from them.

## Phase 7: Packaging, signing and updates

- [ ] electron-builder targets: macOS (DMG + ZIP for updates, hardened runtime, notarized) and Windows (NSIS)
- [ ] Code signing in CI (Developer ID / Authenticode). Secrets go in CI vaults, never in the repo.
- [ ] electron-updater: background download, install on next quit/restart, staged rollout to your own machine first
- [ ] Windows: firewall rule at per-machine install (if testing showed the dialog)

**Exit:** a fresh install on a clean Mac/PC passes Gatekeeper/SmartScreen, and an auto-update keeps every permission grant (no re-prompts).

## Phase 8: Hardening and field trial

- [ ] Threat-model review against [security doc](03-security-and-privacy.md), plus `npm audit` / `cargo audit`
- [ ] Fuzz the protocol parsers, and load-test the signaling rate limits
- [ ] Server: log rotation (7 d), metadata retention (90 d), backups tested by restoring
- [ ] **One to two weeks of real use with Grandma.** Log every moment of confusion and fix the top three.

**Exit:** five real support sessions with no help needed from you beyond "click Yes".

---

## Post-MVP backlog

In rough priority order:

1. **"Show me" pointer.** Draw or point on her screen *without* taking control, which is great for teaching her to do it herself.
2. **Built-in voice** (TeamSpeak-style push-to-talk or open mic) on the same WebRTC connection, replacing the phone call. Adds the microphone permission.
3. **One-click invite link** (`remote-assist://` deep link) for onboarding new family members
4. **Clipboard send** (explicit "Paste on Grandma's computer" button, never automatic sync)
5. **Send a file** (drag onto the remote view, and she sees and accepts it)
6. **Privacy auto-pause** when banking or password-manager windows are focused
7. **Helper on phone/tablet** (view plus tap-to-click PWA)
8. **Reconnect after reboot** (consent is still required)
9. Linux host via xdg-desktop-portal
10. Second helper device per person (link your laptop and desktop)

## Definition of done for the MVP

- ✅ Pair once, then one click for you and one click for her to start
- ✅ p50 glass-to-glass < 150 ms direct, < 250 ms relayed, input feels immediate
- ✅ No OS permission prompts during sessions after setup (macOS monthly caveat until the entitlement)
- ✅ Pause and Stop always work and are enforced by the host
- ✅ Every message authenticated end to end, and the server never sees the screen
- ✅ Signed, notarized, silently updating installers
