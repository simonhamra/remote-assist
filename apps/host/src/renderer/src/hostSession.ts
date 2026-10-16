import {
  createPeerConnection,
  decodeSignal,
  encodeSignal,
  preferVideoCodecs,
  prepareScreenTrack,
  screenCaptureOptions,
  startFakeScreen,
  tuneSender,
  waitForIceGathering,
  type ScreenSource,
} from '@remote-assist/rtc';

/** One screen-sharing session on the host: capture, peer connection and the invite code. */
export class HostSession {
  private constructor(
    readonly pc: RTCPeerConnection,
    readonly source: ScreenSource,
    readonly track: MediaStreamTrack,
    private readonly sender: RTCRtpSender,
    private readonly control: RTCDataChannel,
    readonly inviteCode: string,
  ) {}

  /** Starts capturing and prepares the invite code. Call it straight from a click handler. */
  static async start(fakeScreen: boolean): Promise<HostSession> {
    const source = fakeScreen ? startFakeScreen() : await captureScreen();
    const pc = createPeerConnection();
    try {
      const track = source.stream.getVideoTracks()[0];
      if (!track) throw new Error('The capture has no video track.');
      prepareScreenTrack(track);
      const transceiver = pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [source.stream],
      });
      preferVideoCodecs(transceiver, 'send');
      const control = pc.createDataChannel('ctl', { ordered: true });

      await pc.setLocalDescription();
      await waitForIceGathering(pc);
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error('Could not create an offer.');
      const invite = await encodeSignal({ kind: 'offer', sdp });
      return new HostSession(pc, source, track, transceiver.sender, control, invite);
    } catch (error) {
      pc.close();
      source.stop();
      throw error;
    }
  }

  async acceptReply(code: string): Promise<void> {
    const { sdp } = await decodeSignal(code, 'answer');
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    await tuneSender(this.sender);
  }

  stop(): void {
    if (this.control.readyState === 'open') this.control.send(JSON.stringify({ t: 'end' }));
    this.source.stop();
    // Let the goodbye message leave before the connection is torn down.
    setTimeout(() => this.pc.close(), 200);
  }
}

async function captureScreen(): Promise<ScreenSource> {
  const stream = await navigator.mediaDevices.getDisplayMedia(screenCaptureOptions());
  return { stream, stop: () => stream.getTracks().forEach((track) => track.stop()) };
}
