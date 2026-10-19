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

- [x] Signaling server (Node.js + `ws` + zod, TypeScript run directly by Node): 8-digit single-use session codes valid 10 minutes, relaying offers, answers and trickle ICE candidates, rate limits per address and per connection, heartbeats, browser origins refused, privacy-preserving logs
- [x] Signaling runs in each app's **main process** (`packages/desktop`), so renderers make no network connections and keep their strict CSP
- [x] TURN credentials minted per session for coturn's `use-auth-secret` (HMAC, expiring, nothing stored)
- [x] `infra/`: Docker Compose with Caddy (automatic HTTPS), signaling and coturn (hardened: no relaying into private networks, quotas, bandwidth cap), plus a deploy guide
- [x] Apps get their ICE servers from the server; the host restarts ICE after a network change and a session survives drops of up to 15 s
- [ ] **Deploy to a VPS** and test across two real networks (you: domain + VPS, then [infra/README.md](../infra/README.md))
- Moved: device registration and challenge-response login now come with pairing (Phase 5), since device keys are only useful once they're pinned. SQLite arrives with session history (Phase 4). TURN over TLS on 443 comes later (it needs a second IP or SNI routing).

**Exit:** connects host ↔ helper on two different networks (home Wi-Fi ↔ phone hotspot), and connects with `iceTransportPolicy: "relay"` forced (proving TURN works).

**Results so far** (end-to-end tests on this Mac, synthetic test screen): direct through the signaling server at **38 ms** median glass-to-glass, and relay-only through a local TURN server at **42 ms**, both at 1080p H.264. The local TURN server is a small JavaScript stand-in for coturn using the same expiring credentials. Real coturn and real networks are tested at deployment.

## Phase 3: Remote input

- [x] `packages/native-input`: a **Swift agent** (Quartz Event Services) run as a child process, reading JSON lines: move, button, scroll, key, text, release. It turns moves into drags while a button is held, counts double-clicks, keeps modifier flags, looks shortcut characters up on the current keyboard layout, tags its events, never blocks the local mouse and keyboard, and releases everything when its input closes. A `--dry-run` mode prints events instead, for tests. (Swift instead of Rust + enigo: it comes with the Command Line Tools and needs no extra toolchain.)
- [x] `packages/protocol`: binary pointer codec, zod schemas for input and control messages, and a `hello` so the host can tell when the helper is on the same computer
- [x] Coordinate mapping: normalized → the captured display's bounds in points (works for any display, including ones left of or above the main one)
- [x] Keyboard: typed characters as text; shortcuts, modifiers and special keys as physical codes with the character attached for layout-aware shortcuts; toolbar buttons for ⌘Tab, ⌘Space and ⌥⌘Esc
- [x] Helper: pointer, wheel and key capture over the video (letterbox-aware, coalesced to one move and one scroll per frame, pointer capture for drags), a Control toggle, and release on blur and disconnect
- [x] Input gate (host main process): control on only while live and permitted, own windows protected, key table, 400 events/s cap, release on disconnect, control off, or renderer loss
- [x] Accessibility permission flow on the host, with status shown on both sides
- [ ] **Try it between two real Macs** (you): scroll direction, double-click, typing "Crème brûlée" on the host's layout, ⌘C/⌘V, and dragging a file
- Later: a display switcher for multi-monitor hosts (control follows the captured display already), and a Cmd↔Ctrl mapping for Windows hosts.

**Exit:** from your desktop you can open apps, type "Crème brûlée" correctly on her layout, right-click, drag a file, scroll a web page, and use Cmd/Ctrl+C/V. Killing the helper mid-drag leaves no stuck button or key.

**Results so far:** the end-to-end test drives the whole path with the agent in dry-run mode. A click at 10% / 10% of the picture lands at 10% / 10% of the host's display; drags arrive as drag events; typing arrives as text; ⌘A arrives with the Command flag on the right key for the host's layout (AZERTY here); ⌘W reaches the other Mac without closing the helper window; and Shift held during Disconnect is released on the host. Writing the test found a bug: key-ups were being lost after a cancelled key-down, which would have left ⌘ and Shift stuck. It's fixed, and the test now checks for it. Real event posting still needs the hands-on check above.

## Phase 4: Consent and session safety

- [x] Session states `waiting → asking → connecting → live ⇄ paused → ended`, with the timing rules (60 s to answer, idle warning at 14 min and end at 15, 3-hour cap, idle clock stopped while paused) in a separately tested module
- [x] **Nothing is captured before consent:** the screen capture starts inside the "Yes" click. The consent card shows the helper's name and initial in large type, says what they'll be able to do, counts down 60 seconds, and comes to the front. Silence counts as no. The helper is told "They said no" or "They didn't answer in time".
- [x] Session bar (always on top, every desktop, over full-screen apps, can't be closed by accident, doesn't steal focus) and a red border around the shared screen, which lets clicks through and is left out of the capture
- [x] Pause swaps the picture for a "Paused" card, switches control off in the main process, stops the idle clock and tells the helper. Only the person at the computer can continue. Stop works from either side.
- [x] Auto-end on screen lock, sleep and user switch (`powerMonitor`), after 15 minutes without activity (the helper is warned a minute before), and at 3 hours
- [x] The input gate already drops events aimed at the host app's own windows; that now includes the session bar. (There are no settings screens yet to lock.)
- [x] Session history on the host: every request, accepted or refused, kept 90 days on that computer only and shown on the start screen. Server-side session records come with pairing (Phase 5), when the server knows which devices are involved.
- The helper's name is self-declared until Phase 5 pins device identities. The consent card says: "Only say yes if you are talking to … right now and you asked for help."

**Exit:** a scripted "malicious helper" test (keeps sending input after Pause, clicks the consent and bar areas, floods events) produces **zero** injected events.

**Results:** the end-to-end tests check that:
- while the question is open the helper has no picture, and "No" tells the helper and appears in the history;
- an unanswered question closes after its timeout;
- while paused, raw clicks, keys, text and pointer moves sent straight down the data channels by a modified helper produce zero injected events;
- after Continue, clicks aimed at the session bar are dropped while others go through;
- Stop on the bar ends the session for both sides;
- a locked screen ends the session at once.

Before consent there is no connection at all, so the consent card can't be reached. Floods are capped by the rate limit (unit-tested).

## Phase 5: Pairing and trusted devices

- [x] `packages/crypto`: Ed25519 identities (the public key is the device ID), signatures bound to their purpose, confirmation words (BIP-39 list, 3 words ≈ 33 bits), signed session requests and a replay guard
- [x] Keys at rest through `safeStorage` (Keychain); a new key is made if the stored one can't be read
- [x] Server: sign-in by signed challenge, pairings in SQLite (`node:sqlite`, no native module), presence for paired devices, session requests only between paired devices
- [x] Pairing: 8-digit code (10 min, single use, in memory, rate-limited) → keys exchanged → the same 3 words on both screens → both confirm → each side pins the other
- [x] Signed session requests (sender, recipient, nonce, timestamp) and signed offers and answers. The host rejects unsigned, stale, replayed or unpinned requests; a bad SDP signature ends the session.
- [x] Pairing lock: once a computer has a helper, a new one needs an existing helper's approval, and existing helpers see every attempt
- [x] Removal from either side, applied at once on that device and passed on by the server (or at the next sign-in if offline). Touch ID before a helper's request.
- [x] One-time code sessions kept for development and tests only (`RA_ALLOW_CODE_SESSIONS=1`), with the consent card marking them as unverified
- Not done: a photo (the card shows an initial), an OS-password fallback on Macs without Touch ID, and letting a paired helper switch on one-time codes remotely.

**Exit:** with a tampering proxy in front of the server (modified SDP, swapped keys, replayed requests), every session **fails closed**. Expired, reused and brute-forced codes are rejected.

**Results:** the tampering proxy runs three attacks, and each fails:
- a key swapped during pairing shows different words on the two screens, and nothing is paired;
- an offer altered on the way stops the session before anything connects;
- a replayed genuine request produces no question at all.

Separately, unit and integration tests cover:
- sign-in with a wrong key;
- expired and reused codes;
- per-address rate limits;
- requests to unpaired, offline or busy hosts;
- forged requests;
- approval and refusal of a second helper;
- removal.

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
