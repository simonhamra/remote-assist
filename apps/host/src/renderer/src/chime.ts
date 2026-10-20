/** Short, soft sounds, so a question or a change isn't missed when looking away. */
export type Chime = 'ask' | 'start' | 'end';

const NOTES: Record<Chime, number[]> = {
  // Rising: someone is asking. Higher: help started. Falling: help ended.
  ask: [523.25, 659.25, 783.99],
  start: [659.25, 783.99],
  end: [783.99, 523.25],
};

let context: AudioContext | null = null;

export function playChime(kind: Chime): void {
  try {
    const audio = (context ??= new AudioContext());
    const start = audio.currentTime + 0.02;
    NOTES[kind].forEach((frequency, i) => {
      const at = start + i * 0.18;
      const oscillator = new OscillatorNode(audio, { type: 'sine', frequency });
      const gain = new GainNode(audio, { gain: 0 });
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.5);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.55);
    });
  } catch (error) {
    // No audio device: the window still comes to the front.
    console.warn('Chime failed', error);
  }
}
