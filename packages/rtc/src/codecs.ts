export interface CodecLike {
  mimeType: string;
  sdpFmtpLine?: string;
}

/** Hardware H.264 first (VideoToolbox on macOS keeps the host's CPU low), then software fallbacks. */
export const VIDEO_CODEC_PREFERENCE = ['video/H264', 'video/VP8', 'video/VP9', 'video/AV1'];

// Retransmission and error-correction entries must stay in the list or they get disabled.
const AUXILIARY = new Set(['video/rtx', 'video/red', 'video/ulpfec', 'video/flexfec-03']);

/** Orders codec capabilities for `setCodecPreferences`. Stable within each rank. */
export function orderVideoCodecs<T extends CodecLike>(
  codecs: readonly T[],
  preference: readonly string[] = VIDEO_CODEC_PREFERENCE,
): T[] {
  const wanted = preference.map((mime) => mime.toLowerCase());
  const rank = (codec: T): number => {
    const mime = codec.mimeType.toLowerCase();
    if (AUXILIARY.has(mime)) return wanted.length + 1;
    const index = wanted.indexOf(mime);
    return index === -1 ? wanted.length : index;
  };
  // Within H.264, packetization-mode=1 is the variant every modern endpoint (and hardware) supports.
  const variant = (codec: T): number =>
    codec.mimeType.toLowerCase() === 'video/h264' &&
    !/packetization-mode=1/.test(codec.sdpFmtpLine ?? '')
      ? 1
      : 0;

  return codecs
    .map((codec, index) => ({ codec, index }))
    .sort(
      (a, b) =>
        rank(a.codec) - rank(b.codec) || variant(a.codec) - variant(b.codec) || a.index - b.index,
    )
    .map(({ codec }) => codec);
}
