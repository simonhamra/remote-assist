import {
  statEntries,
  summarizeInbound,
  type InboundVideoSummary,
  type StatEntry,
} from '@remote-assist/rtc';
import { useEffect, useState } from 'react';
import type { LatencyReading } from './useLatency';

interface StatsOverlayProps {
  pc: RTCPeerConnection;
  latency: LatencyReading;
  probeOn: boolean;
}

/** Receiver numbers for the Phase 1 measurements. Toggle with ⌘⇧S / Ctrl+Shift+S. */
export function StatsOverlay({ pc, latency, probeOn }: StatsOverlayProps) {
  const [summary, setSummary] = useState<InboundVideoSummary | null>(null);

  useEffect(() => {
    let previous: StatEntry[] = [];
    let cancelled = false;
    const sample = async () => {
      const current = statEntries(await pc.getStats());
      if (cancelled) return;
      setSummary(summarizeInbound(current, previous));
      previous = current;
    };
    const timer = setInterval(() => void sample(), 1000);
    void sample();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pc]);

  if (!summary) return null;
  const { path } = summary;
  const decoder = [
    summary.decoder,
    summary.hardwareDecoder === undefined
      ? undefined
      : summary.hardwareDecoder
        ? 'hardware'
        : 'software',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <aside className="stats" aria-label="Connection statistics">
      <dl>
        <dt>Glass to glass</dt>
        <dd data-testid="stat-latency" data-p50={latency.p50 ?? ''} data-samples={latency.samples}>
          {!probeOn
            ? 'turn on the latency probe'
            : latency.p50 === undefined
              ? 'measuring…'
              : `${latency.p50} ms (p95 ${latency.p95} ms)`}
        </dd>
        <dt>Path</dt>
        <dd data-testid="stat-path">
          {path.route}
          {path.localType
            ? ` (${path.localType} → ${path.remoteType ?? '?'}, ${path.protocol ?? '?'})`
            : ''}
        </dd>
        <dt>Round trip</dt>
        <dd>{fmt(path.rttMs, 'ms')}</dd>
        <dt>Picture</dt>
        <dd data-testid="stat-resolution">
          {summary.width && summary.height ? `${summary.width} × ${summary.height}` : '—'}
        </dd>
        <dt>Frame rate</dt>
        <dd>{fmt(summary.fps, 'fps')}</dd>
        <dt>Data rate</dt>
        <dd>
          {summary.bitrateKbps === undefined
            ? '—'
            : `${(summary.bitrateKbps / 1000).toFixed(1)} Mbit/s`}
        </dd>
        <dt>Codec</dt>
        <dd data-testid="stat-codec">{summary.codec ?? '—'}</dd>
        <dt>Decoder</dt>
        <dd>{decoder || '—'}</dd>
        <dt>Decode</dt>
        <dd>{fmt(summary.decodeMs, 'ms/frame', 1)}</dd>
        <dt>Jitter buffer</dt>
        <dd>{fmt(summary.jitterBufferMs, 'ms', 1)}</dd>
        <dt>Frames</dt>
        <dd data-testid="stat-frames">{summary.framesDecoded}</dd>
        <dt>Lost packets</dt>
        <dd>{summary.packetsLost ?? '—'}</dd>
        <dt>Freezes</dt>
        <dd>{summary.freezeCount ?? '—'}</dd>
      </dl>
    </aside>
  );
}

function fmt(value: number | undefined, unit: string, digits = 0): string {
  return value === undefined ? '—' : `${value.toFixed(digits)} ${unit}`;
}
