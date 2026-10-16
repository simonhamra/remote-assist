import { fakeScreenTimecodeRect, type NormalizedRect } from '@remote-assist/rtc';
import { useEffect, useRef, useState } from 'react';
import { StatsOverlay } from './StatsOverlay';
import { useLatency } from './useLatency';

interface ViewerProps {
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  fakeScreen: boolean;
  connection: RTCPeerConnectionState;
  onDisconnect(): void;
}

export function Viewer({ pc, stream, fakeScreen, connection, onDisconnect }: ViewerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [showStats, setShowStats] = useState(true);
  // The test screen draws its timecode at a fixed spot; a real screen needs the probe strip.
  const [probeRect, setProbeRect] = useState<NormalizedRect | null>(() =>
    fakeScreen ? fakeScreenTimecodeRect() : null,
  );
  const latency = useLatency(video, probeRect);

  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream]);

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

  return (
    <div className="viewer">
      <header className="toolbar">
        <span className="live">
          {connection === 'disconnected' ? 'Reconnecting…' : 'Viewing their screen'}
        </span>
        <span className="spacer" />
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
        <button type="button" className="danger" onClick={onDisconnect}>
          Disconnect
        </button>
      </header>
      <div className="stage">
        <video ref={video} autoPlay muted playsInline data-testid="remote-video" />
        {showStats && <StatsOverlay pc={pc} latency={latency} probeOn={probeRect !== null} />}
      </div>
    </div>
  );
}
