import {
  TIMECODE_BLOCKS,
  decodeTimecode,
  percentile,
  sampleTimecode,
  timecodeAge,
  type NormalizedRect,
} from '@remote-assist/rtc';
import { useEffect, useState, type RefObject } from 'react';

export interface LatencyReading {
  p50?: number;
  p95?: number;
  samples: number;
}

const SAMPLE_BLOCK = 8;
const WINDOW = 300; // about ten seconds of frames at 30 fps

/**
 * Glass-to-glass latency: reads the timecode strip at `rect` (relative to the video frame) from
 * every received frame and compares it with the clock. Only meaningful on a single machine.
 */
export function useLatency(
  video: RefObject<HTMLVideoElement | null>,
  rect: NormalizedRect | null,
): LatencyReading {
  const [reading, setReading] = useState<LatencyReading>({ samples: 0 });

  useEffect(() => {
    const element = video.current;
    if (!element || !rect) return;
    const canvas = document.createElement('canvas');
    canvas.width = TIMECODE_BLOCKS * SAMPLE_BLOCK;
    canvas.height = SAMPLE_BLOCK;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const ages: number[] = [];
    const onFrame = (): void => {
      const { videoWidth: w, videoHeight: h } = element;
      if (w > 0 && h > 0) {
        ctx.drawImage(
          element,
          rect.x * w,
          rect.y * h,
          rect.width * w,
          rect.height * h,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const timecode = decodeTimecode(sampleTimecode(data, canvas.width, canvas.height));
        if (timecode !== null) {
          const age = timecodeAge(Date.now(), timecode);
          if (age < 5000) {
            ages.push(age);
            if (ages.length > WINDOW) ages.shift();
          }
        }
      }
      handle = element.requestVideoFrameCallback(onFrame);
    };
    let handle = element.requestVideoFrameCallback(onFrame);
    const timer = setInterval(
      () =>
        setReading({ p50: percentile(ages, 50), p95: percentile(ages, 95), samples: ages.length }),
      1000,
    );
    return () => {
      element.cancelVideoFrameCallback(handle);
      clearInterval(timer);
    };
  }, [video, rect]);

  return reading;
}
