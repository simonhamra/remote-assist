import { orderVideoCodecs } from './codecs';

export interface ScreenTuning {
  maxBitrateBps: number;
  maxFramerate: number;
  maxWidth: number;
  maxHeight: number;
}

/** Defaults from docs/01-architecture.md#latency-design. */
export const SCREEN_TUNING: ScreenTuning = {
  maxBitrateBps: 4_000_000,
  maxFramerate: 30,
  maxWidth: 1920,
  maxHeight: 1080,
};

/** A running capture: a real display or the synthetic test screen. */
export interface ScreenSource {
  stream: MediaStream;
  stop(): void;
}

export function createPeerConnection(iceServers: RTCIceServer[] = []): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  });
}

/** Retina and 4K displays are downscaled to fit 1920×1080, keeping the aspect ratio. */
export function screenCaptureOptions(tuning = SCREEN_TUNING): DisplayMediaStreamOptions {
  return {
    audio: false,
    video: {
      frameRate: { ideal: tuning.maxFramerate, max: tuning.maxFramerate },
      width: { max: tuning.maxWidth },
      height: { max: tuning.maxHeight },
    },
  };
}

/** Screen content: keep text sharp and drop frames rather than resolution under pressure. */
export function prepareScreenTrack(track: MediaStreamTrack): void {
  track.contentHint = 'detail';
}

export function preferVideoCodecs(transceiver: RTCRtpTransceiver, side: 'send' | 'receive'): void {
  const capabilities =
    side === 'send'
      ? RTCRtpSender.getCapabilities('video')
      : RTCRtpReceiver.getCapabilities('video');
  if (!capabilities) return;
  try {
    transceiver.setCodecPreferences(orderVideoCodecs(capabilities.codecs));
  } catch (error) {
    console.warn('Could not set codec preferences; using the browser defaults.', error);
  }
}

type SendParameters = RTCRtpSendParameters & {
  degradationPreference?: 'balanced' | 'maintain-framerate' | 'maintain-resolution';
};

/** Call once the remote description is set, when the sender's encodings are final. */
export async function tuneSender(sender: RTCRtpSender, tuning = SCREEN_TUNING): Promise<void> {
  const params = sender.getParameters() as SendParameters;
  const [first, ...rest] = params.encodings;
  if (first) {
    params.encodings = [
      { ...first, maxBitrate: tuning.maxBitrateBps, maxFramerate: tuning.maxFramerate },
      ...rest,
    ];
  }
  params.degradationPreference = 'maintain-resolution';
  await sender.setParameters(params);
}

/** Hint the jitter buffer to add no extra delay: remote control favours latency over smoothness. */
export function tuneReceiver(receiver: RTCRtpReceiver): void {
  receiver.jitterBufferTarget = 0;
}

/**
 * Copy-paste signaling has no trickle ICE, so the code must contain every candidate. Resolves when
 * gathering completes, or after `timeoutMs` with whatever was found.
 */
export function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 3000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = (): void => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}
