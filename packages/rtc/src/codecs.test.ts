import { describe, expect, it } from 'vitest';
import { orderVideoCodecs, type CodecLike } from './codecs';

const label = (codec: CodecLike): string => {
  const name = codec.mimeType.replace('video/', '');
  const mode = /packetization-mode=(\d)/.exec(codec.sdpFmtpLine ?? '')?.[1];
  return name === 'H264' ? `H264/${mode}` : name;
};

const chromeLike: CodecLike[] = [
  { mimeType: 'video/VP8' },
  { mimeType: 'video/rtx', sdpFmtpLine: 'apt=96' },
  { mimeType: 'video/VP9', sdpFmtpLine: 'profile-id=0' },
  {
    mimeType: 'video/H264',
    sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f',
  },
  {
    mimeType: 'video/H264',
    sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f',
  },
  { mimeType: 'video/AV1' },
  { mimeType: 'video/red' },
  { mimeType: 'video/ulpfec' },
];

describe('orderVideoCodecs', () => {
  it('puts H.264 (packetization-mode=1 first) ahead of software codecs, auxiliaries last', () => {
    expect(orderVideoCodecs(chromeLike).map(label)).toEqual([
      'H264/1',
      'H264/0',
      'VP8',
      'VP9',
      'AV1',
      'rtx',
      'red',
      'ulpfec',
    ]);
  });

  it('keeps unknown codecs after preferred ones but before auxiliaries', () => {
    const codecs = [
      { mimeType: 'video/rtx' },
      { mimeType: 'video/H265' },
      { mimeType: 'video/VP8' },
    ];
    expect(orderVideoCodecs(codecs).map(label)).toEqual(['VP8', 'H265', 'rtx']);
  });

  it('accepts a custom preference and does not mutate the input', () => {
    const copy = [...chromeLike];
    expect(orderVideoCodecs(chromeLike, ['video/VP9']).map(label)[0]).toBe('VP9');
    expect(chromeLike).toEqual(copy);
  });
});
