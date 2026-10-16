import { describe, expect, it } from 'vitest';
import { SignalCodeError, decodeSignal, encodeSignal } from './signalCode';

const SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 102 96',
  'c=IN IP4 0.0.0.0',
  'a=candidate:1 1 udp 2122260223 192.168.1.20 52301 typ host generation 0 network-id 1',
  'a=ice-ufrag:abcd',
  'a=ice-pwd:0123456789abcdefghijklmn',
  'a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08',
  'a=setup:actpass',
  'a=mid:0',
  'a=sendonly',
  'a=rtpmap:102 H264/90000',
  'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f',
  'a=rtpmap:96 VP8/90000',
  '',
].join('\r\n');

describe('signal codes', () => {
  it('round-trips an offer', async () => {
    const code = await encodeSignal({ kind: 'offer', sdp: SDP });
    expect(code).toMatch(/^RA1\.[A-Za-z0-9_-]+$/);
    await expect(decodeSignal(code, 'offer')).resolves.toEqual({ kind: 'offer', sdp: SDP });
  });

  it('ignores line breaks and spaces added by chat apps', async () => {
    const code = await encodeSignal({ kind: 'answer', sdp: SDP });
    const wrapped = (code.match(/.{1,40}/g) ?? []).join('\n  ');
    await expect(decodeSignal(` ${wrapped} `, 'answer')).resolves.toEqual({
      kind: 'answer',
      sdp: SDP,
    });
  });

  it('explains when the wrong kind of code is pasted', async () => {
    const offer = await encodeSignal({ kind: 'offer', sdp: SDP });
    const answer = await encodeSignal({ kind: 'answer', sdp: SDP });
    await expect(decodeSignal(offer, 'answer')).rejects.toThrow(/invite code/);
    await expect(decodeSignal(answer, 'offer')).rejects.toThrow(/reply code/);
  });

  it('rejects text that is not a code', async () => {
    await expect(decodeSignal('hello grandma', 'offer')).rejects.toBeInstanceOf(SignalCodeError);
    await expect(decodeSignal('RA1.!!!', 'offer')).rejects.toThrow(/damaged/);
  });

  it('rejects a truncated code', async () => {
    const code = await encodeSignal({ kind: 'offer', sdp: SDP });
    await expect(decodeSignal(code.slice(0, code.length / 2), 'offer')).rejects.toThrow(/damaged/);
  });
});
