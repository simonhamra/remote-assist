import { describe, expect, it } from 'vitest';
import { connectionPath, summarizeInbound, summarizeOutbound, type StatEntry } from './stats';

function network(timestamp: number, localType = 'host'): StatEntry[] {
  return [
    { id: 'T1', type: 'transport', timestamp, selectedCandidatePairId: 'CP1' },
    {
      id: 'CP1',
      type: 'candidate-pair',
      timestamp,
      localCandidateId: 'L1',
      remoteCandidateId: 'R1',
      currentRoundTripTime: 0.012,
      nominated: true,
      state: 'succeeded',
    },
    { id: 'L1', type: 'local-candidate', timestamp, candidateType: localType, protocol: 'udp' },
    { id: 'R1', type: 'remote-candidate', timestamp, candidateType: 'srflx' },
    { id: 'C1', type: 'codec', timestamp, mimeType: 'video/H264' },
  ];
}

describe('summarizeInbound', () => {
  const before: StatEntry[] = [
    ...network(1000),
    {
      id: 'IN1',
      type: 'inbound-rtp',
      kind: 'video',
      timestamp: 1000,
      codecId: 'C1',
      bytesReceived: 1_000_000,
      framesDecoded: 100,
      totalDecodeTime: 0.5,
      jitterBufferDelay: 2,
      jitterBufferEmittedCount: 100,
    },
  ];
  const after: StatEntry[] = [
    ...network(2000),
    {
      id: 'IN1',
      type: 'inbound-rtp',
      kind: 'video',
      timestamp: 2000,
      codecId: 'C1',
      bytesReceived: 1_500_000,
      framesDecoded: 130,
      totalDecodeTime: 0.62,
      jitterBufferDelay: 2.3,
      jitterBufferEmittedCount: 130,
      framesPerSecond: 30,
      frameWidth: 1728,
      frameHeight: 1080,
      decoderImplementation: 'VideoToolbox',
      powerEfficientDecoder: true,
      packetsLost: 0,
      freezeCount: 1,
    },
  ];

  it('computes rates over the sampling interval', () => {
    const summary = summarizeInbound(after, before);
    expect(summary).toMatchObject({
      framesDecoded: 130,
      width: 1728,
      height: 1080,
      fps: 30,
      codec: 'H264',
      decoder: 'VideoToolbox',
      hardwareDecoder: true,
      packetsLost: 0,
      freezeCount: 1,
      path: { route: 'direct', localType: 'host', remoteType: 'srflx', protocol: 'udp' },
    });
    expect(summary.bitrateKbps).toBeCloseTo(4000);
    expect(summary.decodeMs).toBeCloseTo(4);
    expect(summary.jitterBufferMs).toBeCloseTo(10);
    expect(summary.path.rttMs).toBeCloseTo(12);
  });

  it('leaves rates empty without a previous sample', () => {
    const summary = summarizeInbound(after);
    expect(summary.bitrateKbps).toBeUndefined();
    expect(summary.decodeMs).toBeCloseTo((0.62 / 130) * 1000);
  });

  it('reports zero frames before any video arrives', () => {
    expect(summarizeInbound(network(0))).toEqual({
      framesDecoded: 0,
      path: expect.objectContaining({ route: 'direct' }),
    });
  });
});

describe('summarizeOutbound', () => {
  it('reports the encoder and quality limitation', () => {
    const outbound = (timestamp: number, bytesSent: number, framesEncoded: number, t: number) => ({
      id: 'OUT1',
      type: 'outbound-rtp',
      kind: 'video',
      timestamp,
      codecId: 'C1',
      bytesSent,
      framesEncoded,
      totalEncodeTime: t,
      framesPerSecond: 30,
      encoderImplementation: 'VideoToolbox',
      powerEfficientEncoder: true,
      qualityLimitationReason: 'none',
    });
    const summary = summarizeOutbound(
      [...network(2000), outbound(2000, 750_000, 160, 0.4)],
      [...network(1000), outbound(1000, 250_000, 130, 0.25)],
    );
    expect(summary).toMatchObject({
      framesEncoded: 160,
      encoder: 'VideoToolbox',
      hardwareEncoder: true,
      qualityLimitation: 'none',
      codec: 'H264',
    });
    expect(summary.bitrateKbps).toBeCloseTo(4000);
    expect(summary.encodeMs).toBeCloseTo(5);
  });
});

describe('connectionPath', () => {
  it('detects a TURN relay', () => {
    expect(connectionPath(network(0, 'relay')).route).toBe('relay');
  });

  it('falls back to the nominated pair when there is no transport entry', () => {
    const stats = network(0).filter((s) => s.type !== 'transport');
    expect(connectionPath(stats).route).toBe('direct');
  });

  it('is unknown before ICE succeeds', () => {
    expect(connectionPath([])).toEqual({ route: 'unknown' });
  });
});
