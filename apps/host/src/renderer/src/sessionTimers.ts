export interface SessionLimits {
  /** How long the person has to answer the consent question. */
  consentMs: number;
  /** A session with no helper activity for this long ends. */
  idleMs: number;
  /** The helper is warned this long before an idle session ends. */
  idleWarningMs: number;
  /** Hard cap on a session, paused or not. */
  maxMs: number;
}

export const DEFAULT_LIMITS: SessionLimits = {
  consentMs: 60_000,
  idleMs: 15 * 60_000,
  idleWarningMs: 60_000,
  maxMs: 3 * 60 * 60_000,
};

export type TimerEvent =
  | { t: 'consent-expired' }
  | { t: 'idle-warning'; secondsLeft: number }
  | { t: 'idle-ended' }
  | { t: 'max-reached' };

/**
 * The timing rules of one session, kept apart from WebRTC so they can be tested with a fake
 * clock. Activity is only recorded (it arrives many times a second); a single timer checks it
 * when a warning or an end is due.
 */
export class SessionTimers {
  private readonly limits: SessionLimits;
  private readonly onEvent: (event: TimerEvent) => void;
  private consentTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private maxTimer: ReturnType<typeof setTimeout> | undefined;
  private live = false;
  private paused = false;
  private warned = false;
  private lastActivity = 0;

  constructor(limits: SessionLimits, onEvent: (event: TimerEvent) => void) {
    this.limits = limits;
    this.onEvent = onEvent;
  }

  startConsent(): void {
    clearTimeout(this.consentTimer);
    this.consentTimer = setTimeout(
      () => this.onEvent({ t: 'consent-expired' }),
      this.limits.consentMs,
    );
  }

  stopConsent(): void {
    clearTimeout(this.consentTimer);
  }

  startLive(): void {
    if (this.live) return;
    this.live = true;
    this.maxTimer = setTimeout(() => this.onEvent({ t: 'max-reached' }), this.limits.maxMs);
    this.activity();
    this.scheduleIdleCheck();
  }

  /** The helper did something. Cheap enough to call for every input event. */
  activity(): void {
    this.lastActivity = Date.now();
    if (this.warned) {
      this.warned = false;
      this.scheduleIdleCheck();
    }
  }

  /** While paused the helper can't act, so the idle clock stops (the cap keeps running). */
  pause(): void {
    this.paused = true;
    clearTimeout(this.idleTimer);
    this.warned = false;
  }

  resume(): void {
    this.paused = false;
    this.activity();
    this.scheduleIdleCheck();
  }

  dispose(): void {
    clearTimeout(this.consentTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.maxTimer);
    this.live = false;
  }

  private scheduleIdleCheck(): void {
    clearTimeout(this.idleTimer);
    if (!this.live || this.paused) return;
    const now = Date.now();
    const endAt = this.lastActivity + this.limits.idleMs;
    const warnAt = endAt - this.limits.idleWarningMs;
    if (now >= endAt) {
      this.onEvent({ t: 'idle-ended' });
      return;
    }
    if (!this.warned && now >= warnAt) {
      this.warned = true;
      this.onEvent({ t: 'idle-warning', secondsLeft: Math.ceil((endAt - now) / 1000) });
    }
    const next = this.warned ? endAt : warnAt;
    this.idleTimer = setTimeout(() => this.scheduleIdleCheck(), next - now);
  }
}
