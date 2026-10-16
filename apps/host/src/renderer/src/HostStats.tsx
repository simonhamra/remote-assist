import {
  statEntries,
  summarizeOutbound,
  type OutboundVideoSummary,
  type StatEntry,
} from '@remote-assist/rtc';
import { useEffect, useState } from 'react';

/** Live sender numbers for the Phase 1 measurements (resolution, frame rate, encoder, CPU). */
export function HostStats({ pc }: { pc: RTCPeerConnection }) {
  const [summary, setSummary] = useState<OutboundVideoSummary | null>(null);
  const [cpu, setCpu] = useState<number | null>(null);

  useEffect(() => {
    let previous: StatEntry[] = [];
    let cancelled = false;
    const sample = async () => {
      const current = statEntries(await pc.getStats());
      const cpuNow = await window.hostApi.cpuPercent();
      if (cancelled) return;
      setSummary(summarizeOutbound(current, previous));
      setCpu(cpuNow);
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
  const encoder = [
    summary.codec,
    summary.encoder,
    summary.hardwareEncoder === undefined
      ? undefined
      : summary.hardwareEncoder
        ? 'hardware'
        : 'software',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <details className="stats">
      <summary>Technical details</summary>
      <dl>
        <dt>Picture</dt>
        <dd data-testid="stat-picture">
          {summary.width && summary.height ? `${summary.width} × ${summary.height}` : '—'}
          {summary.fps === undefined ? '' : ` at ${Math.round(summary.fps)} fps`}
        </dd>
        <dt>Data rate</dt>
        <dd>
          {summary.bitrateKbps === undefined
            ? '—'
            : `${(summary.bitrateKbps / 1000).toFixed(1)} Mbit/s`}
        </dd>
        <dt>Encoder</dt>
        <dd data-testid="stat-encoder">{encoder || '—'}</dd>
        <dt>Encode time</dt>
        <dd>
          {summary.encodeMs === undefined ? '—' : `${summary.encodeMs.toFixed(1)} ms per frame`}
        </dd>
        <dt>Held back by</dt>
        <dd>
          {!summary.qualityLimitation || summary.qualityLimitation === 'none'
            ? 'nothing'
            : summary.qualityLimitation}
        </dd>
        <dt>Connection</dt>
        <dd>
          {path.route}
          {path.rttMs === undefined ? '' : ` · ${Math.round(path.rttMs)} ms round trip`}
        </dd>
        <dt>App CPU</dt>
        <dd data-testid="stat-cpu">{cpu === null ? '—' : `${Math.round(cpu)}% of one core`}</dd>
      </dl>
    </details>
  );
}
