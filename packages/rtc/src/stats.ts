/** One entry of an RTCStatsReport, loosely typed so tests can use plain objects. */
export type StatEntry = { id: string; type: string; timestamp: number } & Record<string, unknown>;

export interface ConnectionPath {
  /** `relay` means traffic goes through a TURN server; anything else is peer-to-peer. */
  route: 'direct' | 'relay' | 'unknown';
  localType?: string;
  remoteType?: string;
  protocol?: string;
  rttMs?: number;
}

export interface InboundVideoSummary {
  path: ConnectionPath;
  framesDecoded: number;
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  codec?: string;
  decoder?: string;
  hardwareDecoder?: boolean;
  decodeMs?: number;
  jitterBufferMs?: number;
  packetsLost?: number;
  freezeCount?: number;
}

export interface OutboundVideoSummary {
  path: ConnectionPath;
  framesEncoded: number;
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  codec?: string;
  encoder?: string;
  hardwareEncoder?: boolean;
  encodeMs?: number;
  qualityLimitation?: string;
}

export function statEntries(report: RTCStatsReport): StatEntry[] {
  return Array.from(report.values()) as StatEntry[];
}

/** Summarizes the received video stream. Rates are computed against `previous` when given. */
export function summarizeInbound(
  current: readonly StatEntry[],
  previous: readonly StatEntry[] = [],
): InboundVideoSummary {
  const rtp = current.find((s) => s.type === 'inbound-rtp' && s.kind === 'video');
  const path = connectionPath(current);
  if (!rtp) return { path, framesDecoded: 0 };
  const before = previous.find((s) => s.id === rtp.id);
  const bytesPerSecond = perSecond(rtp, before, 'bytesReceived');

  return {
    path,
    framesDecoded: num(rtp, 'framesDecoded') ?? 0,
    width: num(rtp, 'frameWidth'),
    height: num(rtp, 'frameHeight'),
    fps: num(rtp, 'framesPerSecond'),
    bitrateKbps: bytesPerSecond === undefined ? undefined : (bytesPerSecond * 8) / 1000,
    codec: codecName(current, rtp),
    decoder: str(rtp, 'decoderImplementation'),
    hardwareDecoder: bool(rtp, 'powerEfficientDecoder'),
    decodeMs: msPer(rtp, before, 'totalDecodeTime', 'framesDecoded'),
    jitterBufferMs: msPer(rtp, before, 'jitterBufferDelay', 'jitterBufferEmittedCount'),
    packetsLost: num(rtp, 'packetsLost'),
    freezeCount: num(rtp, 'freezeCount'),
  };
}

/** Summarizes the sent video stream. Rates are computed against `previous` when given. */
export function summarizeOutbound(
  current: readonly StatEntry[],
  previous: readonly StatEntry[] = [],
): OutboundVideoSummary {
  const rtp = current.find((s) => s.type === 'outbound-rtp' && s.kind === 'video');
  const path = connectionPath(current);
  if (!rtp) return { path, framesEncoded: 0 };
  const before = previous.find((s) => s.id === rtp.id);
  const bytesPerSecond = perSecond(rtp, before, 'bytesSent');

  return {
    path,
    framesEncoded: num(rtp, 'framesEncoded') ?? 0,
    width: num(rtp, 'frameWidth'),
    height: num(rtp, 'frameHeight'),
    fps: num(rtp, 'framesPerSecond'),
    bitrateKbps: bytesPerSecond === undefined ? undefined : (bytesPerSecond * 8) / 1000,
    codec: codecName(current, rtp),
    encoder: str(rtp, 'encoderImplementation'),
    hardwareEncoder: bool(rtp, 'powerEfficientEncoder'),
    encodeMs: msPer(rtp, before, 'totalEncodeTime', 'framesEncoded'),
    qualityLimitation: str(rtp, 'qualityLimitationReason'),
  };
}

export function connectionPath(stats: readonly StatEntry[]): ConnectionPath {
  const pair = selectedPair(stats);
  if (!pair) return { route: 'unknown' };
  const local = stats.find((s) => s.id === pair.localCandidateId);
  const remote = stats.find((s) => s.id === pair.remoteCandidateId);
  const localType = local && str(local, 'candidateType');
  const remoteType = remote && str(remote, 'candidateType');
  const rtt = num(pair, 'currentRoundTripTime');
  return {
    route: localType === 'relay' || remoteType === 'relay' ? 'relay' : 'direct',
    localType,
    remoteType,
    protocol: local && str(local, 'protocol'),
    rttMs: rtt === undefined ? undefined : rtt * 1000,
  };
}

function selectedPair(stats: readonly StatEntry[]): StatEntry | undefined {
  const transport = stats.find((s) => s.type === 'transport' && s.selectedCandidatePairId);
  if (transport) return stats.find((s) => s.id === transport.selectedCandidatePairId);
  return stats.find(
    (s) => s.type === 'candidate-pair' && s.nominated === true && s.state === 'succeeded',
  );
}

function codecName(stats: readonly StatEntry[], rtp: StatEntry): string | undefined {
  const codec = stats.find((s) => s.type === 'codec' && s.id === rtp.codecId);
  return codec && str(codec, 'mimeType')?.replace(/^video\//, '');
}

function perSecond(
  current: StatEntry,
  previous: StatEntry | undefined,
  key: string,
): number | undefined {
  const now = num(current, key);
  const then = previous && num(previous, key);
  const seconds = previous ? (current.timestamp - previous.timestamp) / 1000 : 0;
  if (now === undefined || then === undefined || seconds <= 0) return undefined;
  return (now - then) / seconds;
}

/** Average milliseconds of `secondsKey` per unit of `countKey` over the sampling interval. */
function msPer(
  current: StatEntry,
  previous: StatEntry | undefined,
  secondsKey: string,
  countKey: string,
): number | undefined {
  const seconds = delta(current, previous, secondsKey);
  const count = delta(current, previous, countKey);
  if (seconds === undefined || !count) return undefined;
  return (seconds / count) * 1000;
}

function delta(current: StatEntry, previous: StatEntry | undefined, key: string) {
  const now = num(current, key);
  if (now === undefined) return undefined;
  return now - ((previous && num(previous, key)) ?? 0);
}

function num(entry: StatEntry, key: string): number | undefined {
  const value = entry[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(entry: StatEntry, key: string): string | undefined {
  const value = entry[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function bool(entry: StatEntry, key: string): boolean | undefined {
  const value = entry[key];
  return typeof value === 'boolean' ? value : undefined;
}
