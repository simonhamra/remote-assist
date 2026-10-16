import {
  createPeerConnection,
  decodeSignal,
  encodeSignal,
  preferVideoCodecs,
  tuneReceiver,
  waitForIceGathering,
} from '@remote-assist/rtc';

interface SessionEvents {
  onStream(stream: MediaStream): void;
  /** The host said goodbye (pressed Stop) over the control channel. */
  onHostEnded(): void;
}

/** The helper's side of one session: answers the host's invite and receives the screen. */
export class HelperSession {
  private constructor(
    readonly pc: RTCPeerConnection,
    readonly replyCode: string,
  ) {}

  static async fromInvite(code: string, events: SessionEvents): Promise<HelperSession> {
    const { sdp } = await decodeSignal(code, 'offer');
    const pc = createPeerConnection();
    try {
      pc.addEventListener('track', (event) => {
        tuneReceiver(event.receiver);
        events.onStream(event.streams[0] ?? new MediaStream([event.track]));
      });
      pc.addEventListener('datachannel', ({ channel }) => {
        if (channel.label !== 'ctl') return;
        channel.addEventListener('message', ({ data }) => {
          if (isEndMessage(data)) events.onHostEnded();
        });
      });

      await pc.setRemoteDescription({ type: 'offer', sdp });
      const transceiver = pc.getTransceivers()[0];
      if (transceiver) preferVideoCodecs(transceiver, 'receive');
      await pc.setLocalDescription();
      await waitForIceGathering(pc);
      const answer = pc.localDescription?.sdp;
      if (!answer) throw new Error('Could not create a reply.');
      return new HelperSession(pc, await encodeSignal({ kind: 'answer', sdp: answer }));
    } catch (error) {
      pc.close();
      throw error;
    }
  }

  close(): void {
    this.pc.close();
  }
}

function isEndMessage(data: unknown): boolean {
  if (typeof data !== 'string') return false;
  try {
    const message: unknown = JSON.parse(data);
    return typeof message === 'object' && message !== null && 't' in message && message.t === 'end';
  } catch {
    return false;
  }
}
