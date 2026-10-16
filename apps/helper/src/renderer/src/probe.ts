import { TIMECODE_BLOCKS, drawTimecode } from '@remote-assist/rtc';
import './probe.css';

const canvas = document.querySelector('canvas');
const ctx = canvas?.getContext('2d');
if (!canvas || !ctx) throw new Error('Canvas 2D is not available.');

const draw = (): void => {
  const width = Math.round(innerWidth * devicePixelRatio);
  const height = Math.round(innerHeight * devicePixelRatio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  drawTimecode(ctx, 0, 0, width / TIMECODE_BLOCKS, height, Date.now());
  requestAnimationFrame(draw);
};
requestAnimationFrame(draw);
