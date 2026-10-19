import type { ScreenSource } from '@remote-assist/rtc';

/** What the helper sees instead of the screen while the session is paused. */
export function startPausedCard(): ScreenSource {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available.');

  const draw = (): void => {
    ctx.fillStyle = '#1f2430';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = '700 64px system-ui, sans-serif';
    ctx.fillText('Paused', canvas.width / 2, 330);
    ctx.fillStyle = '#9aa3ae';
    ctx.font = '36px system-ui, sans-serif';
    ctx.fillText('The screen is hidden until they continue.', canvas.width / 2, 400);
  };
  draw();
  // A still picture still needs the odd frame, or a newly connected viewer would see nothing.
  const timer = setInterval(draw, 1000);
  const stream = canvas.captureStream(1);
  return {
    stream,
    stop: () => {
      clearInterval(timer);
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
