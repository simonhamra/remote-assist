import { fakeScreenTimecodeRect, type NormalizedRect } from '@remote-assist/rtc';
import { useEffect, useRef, useState } from 'react';
import type { HelperSession, HelperState } from './helperSession';
import { StatsOverlay } from './StatsOverlay';
import { useLatency } from './useLatency';
import { useRemoteInput } from './useRemoteInput';

interface ViewerProps {
  session: HelperSession;
  state: Extract<HelperState, { name: 'live' }>;
  pc: RTCPeerConnection;
  fakeScreen: boolean;
}

/** Key combinations macOS keeps for itself, so they can't be typed into the viewer. */
const SYSTEM_SHORTCUTS = [
  { label: '⌘ Tab', title: 'Switch apps', codes: ['MetaLeft', 'Tab'] },
  { label: '⌘ Space', title: 'Spotlight search', codes: ['MetaLeft', 'Space'] },
  { label: '⌥⌘ Esc', title: 'Force Quit window', codes: ['MetaLeft', 'AltLeft', 'Escape'] },
];

export function Viewer({ session, state, pc, fakeScreen }: ViewerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [showStats, setShowStats] = useState(true);
  const [controlOn, setControlOn] = useState(true);
  // The test screen draws its timecode at a fixed spot; a real screen needs the probe strip.
  const [probeRect, setProbeRect] = useState<NormalizedRect | null>(() =>
    fakeScreen ? fakeScreenTimecodeRect() : null,
  );
  const latency = useLatency(video, probeRect);
  const canControl = state.control?.available === true;
  const controlling = canControl && controlOn && !state.reconnecting;
  useRemoteInput(video, session, controlling);

  useEffect(() => {
    if (video.current) video.current.srcObject = state.stream;
  }, [state.stream]);

  // ⌘⇧S toggles the stats while not controlling (while controlling, keys go to their computer).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        setShowStats((shown) => !shown);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(
    () => () => {
      void window.helperApi.hideProbe();
    },
    [],
  );

  const toggleProbe = async () => {
    if (probeRect) {
      await window.helperApi.hideProbe();
      setProbeRect(null);
    } else {
      setProbeRect(await window.helperApi.showProbe());
    }
  };

  const sendShortcut = (codes: string[]) => {
    for (const code of codes) session.sendInput({ t: 'key', code, down: true });
    for (const code of [...codes].reverse()) session.sendInput({ t: 'key', code, down: false });
  };

  return (
    <div className="viewer">
      <header className="toolbar">
        <span className="live" data-testid="viewer-status">
          {state.reconnecting
            ? 'Reconnecting…'
            : controlling
              ? 'Controlling their screen'
              : 'Viewing their screen'}
        </span>
        <ControlNote control={state.control} />
        <span className="spacer" />
        {controlling &&
          SYSTEM_SHORTCUTS.map((shortcut) => (
            <button
              key={shortcut.label}
              type="button"
              title={shortcut.title}
              onClick={() => sendShortcut(shortcut.codes)}
            >
              {shortcut.label}
            </button>
          ))}
        <button
          type="button"
          aria-pressed={controlOn}
          disabled={!canControl}
          onClick={() => setControlOn((on) => !on)}
          title="Use your mouse and keyboard on their computer"
          data-testid="control-toggle"
        >
          Control
        </button>
        {!fakeScreen && (
          <button
            type="button"
            aria-pressed={probeRect !== null}
            onClick={() => void toggleProbe()}
            title="Same-Mac test: shows a time strip on your main display and reads it back from the video"
          >
            Latency probe
          </button>
        )}
        <button type="button" aria-pressed={showStats} onClick={() => setShowStats((s) => !s)}>
          Stats
        </button>
        <button type="button" className="danger" onClick={() => session.disconnect()}>
          Disconnect
        </button>
      </header>
      <div className={controlling ? 'stage controlling' : 'stage'}>
        <video ref={video} autoPlay muted playsInline data-testid="remote-video" />
        {showStats && <StatsOverlay pc={pc} latency={latency} probeOn={probeRect !== null} />}
      </div>
    </div>
  );
}

function ControlNote({ control }: { control: ViewerProps['state']['control'] }) {
  if (!control || control.available) return null;
  return (
    <span className="control-note" data-testid="control-note">
      {control.reason === 'permission'
        ? 'They need to allow mouse and keyboard control (macOS Accessibility).'
        : control.reason === 'same-computer'
          ? 'Control is off: both apps run on this computer, so it would only control itself.'
          : 'Mouse and keyboard control is not available on their computer.'}
    </span>
  );
}
