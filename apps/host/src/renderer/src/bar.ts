import type { ChromeState } from '../../shared/api';
import './bar.css';

const label = document.getElementById('label');
const pause = document.getElementById('pause');
const stop = document.getElementById('stop');
if (!label || !pause || !stop) throw new Error('Session bar markup is missing.');

let paused = false;

window.barApi.onState((state: ChromeState) => {
  paused = state.paused;
  document.body.classList.toggle('paused', paused);
  label.textContent = paused
    ? `Paused: ${state.helperName} can't see or use your screen`
    : `${state.helperName} is helping you`;
  pause.textContent = paused ? 'Continue' : 'Pause';
});

pause.addEventListener('click', () => window.barApi.send(paused ? 'resume' : 'pause'));
stop.addEventListener('click', () => window.barApi.send('stop'));
