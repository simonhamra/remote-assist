import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS, SessionTimers, type TimerEvent } from './sessionTimers';

const MINUTE = 60_000;

function setup() {
  const events: TimerEvent[] = [];
  const timers = new SessionTimers(DEFAULT_LIMITS, (event) => events.push(event));
  return { timers, events };
}

describe('SessionTimers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives the person 60 seconds to answer', () => {
    const { timers, events } = setup();
    timers.startConsent();
    vi.advanceTimersByTime(59_999);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual([{ t: 'consent-expired' }]);
  });

  it('does not expire once answered', () => {
    const { timers, events } = setup();
    timers.startConsent();
    timers.stopConsent();
    vi.advanceTimersByTime(2 * MINUTE);
    expect(events).toEqual([]);
  });

  it('warns the helper a minute before an idle session ends, then ends it', () => {
    const { timers, events } = setup();
    timers.startLive();
    vi.advanceTimersByTime(14 * MINUTE);
    expect(events).toEqual([{ t: 'idle-warning', secondsLeft: 60 }]);
    vi.advanceTimersByTime(MINUTE);
    expect(events.at(-1)).toEqual({ t: 'idle-ended' });
  });

  it('keeps an active session going', () => {
    const { timers, events } = setup();
    timers.startLive();
    for (let minute = 0; minute < 40; minute++) {
      vi.advanceTimersByTime(MINUTE);
      timers.activity();
    }
    expect(events).toEqual([]);
  });

  it('activity after the warning clears it', () => {
    const { timers, events } = setup();
    timers.startLive();
    vi.advanceTimersByTime(14.5 * MINUTE);
    timers.activity();
    // Fourteen more quiet minutes are needed before the next warning; ten aren't.
    vi.advanceTimersByTime(10 * MINUTE);
    expect(events).toEqual([{ t: 'idle-warning', secondsLeft: 60 }]);
  });

  it('stops the idle clock while paused, but not the 3-hour cap', () => {
    const { timers, events } = setup();
    timers.startLive();
    timers.pause();
    vi.advanceTimersByTime(60 * MINUTE);
    expect(events).toEqual([]);
    timers.resume();
    vi.advanceTimersByTime(14 * MINUTE);
    expect(events).toEqual([{ t: 'idle-warning', secondsLeft: 60 }]);
    timers.pause();
    vi.advanceTimersByTime(3 * 60 * MINUTE);
    expect(events.at(-1)).toEqual({ t: 'max-reached' });
  });

  it('stays quiet after being disposed', () => {
    const { timers, events } = setup();
    timers.startConsent();
    timers.startLive();
    timers.dispose();
    vi.advanceTimersByTime(4 * 60 * MINUTE);
    expect(events).toEqual([]);
  });
});
