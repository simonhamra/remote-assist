import type { PeopleState } from '@remote-assist/desktop/channels';
import { useEffect, useState } from 'react';
import {
  SETUP_STEPS,
  type AppConfig,
  type LoginItem,
  type ScreenPermission,
  type SetupStep,
} from '../../shared/api';
import { PairingView } from './Home';

/** The numbered steps; `done` is the closing screen. */
const NUMBERED: readonly SetupStep[] = SETUP_STEPS.filter((step) => step !== 'done');

/**
 * The first-run setup: one question per screen, in plain words, with the system permissions
 * explained before macOS asks. Every step can be skipped and done later; nothing here shares
 * anything.
 */
export function Setup({
  config,
  people,
  initialStep,
  onDone,
}: {
  config: AppConfig;
  people: PeopleState;
  initialStep: SetupStep;
  onDone(): void;
}) {
  const [step, setStep] = useState<SetupStep>(initialStep);
  const go = (next: SetupStep) => {
    setStep(next);
    void window.hostApi.setSetupStep(next);
  };
  const index = SETUP_STEPS.indexOf(step);
  const next = () => go(SETUP_STEPS[Math.min(index + 1, SETUP_STEPS.length - 1)] ?? 'done');
  const back = index > 0 ? () => go(SETUP_STEPS[index - 1] ?? 'welcome') : undefined;
  const finish = () => void window.hostApi.completeSetup().then(onDone);
  const helperName = people.peers.find((peer) => peer.role === 'helper')?.name;

  return (
    <section className="setup" data-testid="setup" aria-labelledby="setup-title">
      {step !== 'done' && <Progress step={step} />}
      {step === 'welcome' && <Welcome onNext={next} />}
      {step === 'pair' && <PairStep people={people} onNext={next} />}
      {step === 'screen' && <ScreenStep fakeScreen={config.fakeScreen} onNext={next} />}
      {step === 'control' && <ControlStep onNext={next} />}
      {step === 'startup' && <StartupStep onNext={next} />}
      {step === 'practice' && <Practice helperName={helperName ?? 'Your helper'} onNext={next} />}
      {step === 'done' && <Done onFinish={finish} />}
      {back && people.pairing.step === 'idle' && (
        <button type="button" className="link" onClick={back}>
          ← Back
        </button>
      )}
    </section>
  );
}

function Progress({ step }: { step: SetupStep }) {
  const number = NUMBERED.indexOf(step) + 1;
  return (
    <div className="progress">
      <p className="hint" data-testid="setup-progress">
        Step {number} of {NUMBERED.length}
      </p>
      <ol aria-hidden="true">
        {NUMBERED.map((name, i) => (
          <li key={name} className={i < number ? 'reached' : undefined} />
        ))}
      </ol>
    </div>
  );
}

function Welcome({ onNext }: { onNext(): void }) {
  return (
    <div className="card setup-card">
      <h2 id="setup-title">Welcome</h2>
      <p>
        Remote Assist lets someone you trust see your screen and help you, from wherever they are.
      </p>
      <p>
        Setting it up takes about five minutes. If your helper can be on the phone with you, even
        better.
      </p>
      <p className="reassure">Nothing is ever shared unless you say yes first.</p>
      <button type="button" className="primary big" onClick={onNext}>
        Let&apos;s start
      </button>
    </div>
  );
}

function PairStep({ people, onNext }: { people: PeopleState; onNext(): void }) {
  if (people.pairing.step !== 'idle') return <PairingView people={people} />;
  const helpers = people.peers.filter((peer) => peer.role === 'helper');
  const online = people.connection === 'online';
  return (
    <div className="card setup-card">
      <h2 id="setup-title">Pair with your helper</h2>
      {helpers.length > 0 ? (
        <>
          <p className="done-line" data-testid="setup-paired">
            ✓ {helpers.map((helper) => helper.name).join(', ')} can ask to help you.
          </p>
          <button type="button" className="primary big" onClick={onNext}>
            Continue
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void window.hostApi.startPairing()}
            disabled={!online}
          >
            Add another helper
          </button>
        </>
      ) : (
        <>
          <p>
            Pairing tells this computer who your helper is. You do it once; afterwards your helper
            can ask to help, and you answer each time.
          </p>
          <p>You will read a number to your helper, then check three words together.</p>
          {!online && (
            <p className="warning" role="status">
              {people.connection === 'connecting'
                ? 'Connecting…'
                : 'Not connected to the internet. Pairing needs a connection.'}
            </p>
          )}
          <button
            type="button"
            className="primary big"
            onClick={() => void window.hostApi.startPairing()}
            disabled={!online}
          >
            Pair with my helper
          </button>
          <button type="button" className="secondary" onClick={onNext}>
            Do this later
          </button>
        </>
      )}
    </div>
  );
}

/** Calls `check` now, every few seconds, and when the window comes back from System Settings. */
function usePolling<T>(check: () => Promise<T>, initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void check().then((result) => {
        if (active) setValue(result);
      });
    refresh();
    const timer = setInterval(refresh, 2000);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [check]);
  return value;
}

const screenPermission = () => window.hostApi.screenPermission();
const accessibilityGranted = () => window.hostApi.accessibilityGranted();

function ScreenStep({ fakeScreen, onNext }: { fakeScreen: boolean; onNext(): void }) {
  const permission = usePolling<ScreenPermission>(screenPermission, 'unknown');
  const [opened, setOpened] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const allowed = fakeScreen || permission === 'granted';

  const open = async () => {
    // macOS only lists apps that have asked once, so ask first, then show the switch.
    await window.hostApi.registerScreenRecording();
    await window.hostApi.openScreenRecordingSettings();
    setOpened(true);
  };
  const restart = () =>
    window.hostApi
      .relaunch()
      .catch(() => setRestartError('Please quit Remote Assist and open it again.'));

  return (
    <div className="card setup-card">
      <h2 id="setup-title">Let your helper see your screen</h2>
      {allowed ? (
        <>
          <p className="done-line" data-testid="setup-screen-ok">
            ✓ Your Mac allows screen sharing.
          </p>
          <p>You will still be asked every time before anyone sees it.</p>
          <button type="button" className="primary big" onClick={onNext}>
            Continue
          </button>
        </>
      ) : (
        <>
          <p>
            Your Mac asks for permission once. This does not share anything yet: you will be asked
            every time.
          </p>
          <ol className="instructions">
            <li>Press the button below. System Settings opens.</li>
            <li>
              Find <strong>Remote Assist</strong> in the list and switch it on.
            </li>
            <li>
              If your Mac asks, choose <strong>Quit &amp; Reopen</strong>. Remote Assist comes back
              to this step.
            </li>
          </ol>
          <button type="button" className="primary big" onClick={() => void open()}>
            Open System Settings
          </button>
          {opened && (
            <button type="button" className="secondary" onClick={() => void restart()}>
              I switched it on: restart Remote Assist
            </button>
          )}
          {restartError && (
            <p className="warning" role="status">
              {restartError}
            </p>
          )}
          <button type="button" className="link" onClick={onNext}>
            Skip for now
          </button>
        </>
      )}
    </div>
  );
}

function ControlStep({ onNext }: { onNext(): void }) {
  const granted = usePolling<boolean>(accessibilityGranted, false);
  return (
    <div className="card setup-card">
      <h2 id="setup-title">Let your helper use your mouse and keyboard</h2>
      {granted ? (
        <>
          <p className="done-line" data-testid="setup-control-ok">
            ✓ Your helper can click and type for you, but only while you are sharing.
          </p>
          <button type="button" className="primary big" onClick={onNext}>
            Continue
          </button>
        </>
      ) : (
        <>
          <p>
            Then your helper can click and type for you, only while you are sharing your screen.
            This is optional: without it, your helper can still see your screen and guide you.
          </p>
          <ol className="instructions">
            <li>Press the button below. System Settings opens.</li>
            <li>
              Switch on <strong>Remote Assist</strong> under Accessibility.
            </li>
          </ol>
          <button
            type="button"
            className="primary big"
            onClick={() => void window.hostApi.openAccessibilitySettings()}
          >
            Open System Settings
          </button>
          <button type="button" className="secondary" onClick={onNext}>
            Not now
          </button>
        </>
      )}
    </div>
  );
}

function StartupStep({ onNext }: { onNext(): void }) {
  const [item, setItem] = useState<LoginItem | null>(null);
  useEffect(() => {
    void window.hostApi.startAtLogin().then(setItem);
  }, []);
  const choose = (enabled: boolean) =>
    void window.hostApi.setStartAtLogin(enabled).then((result) => {
      setItem(result);
      onNext();
    });

  return (
    <div className="card setup-card">
      <h2 id="setup-title">Start with your computer?</h2>
      <p>
        Then your helper can reach you without you opening anything first. Remote Assist waits
        quietly at the top of the screen, as a small circle next to the clock.
      </p>
      {item && !item.supported ? (
        <>
          <p className="hint" data-testid="setup-startup-unsupported">
            This works once Remote Assist is installed in Applications.
          </p>
          <button type="button" className="primary big" onClick={onNext}>
            Continue
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="primary big"
            onClick={() => choose(true)}
            disabled={!item}
          >
            Yes, start with my computer
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => choose(false)}
            disabled={!item}
          >
            No, I will open it myself
          </button>
        </>
      )}
    </div>
  );
}

type PracticeStage = 'asked' | 'said-no' | 'live' | 'paused' | 'stopped';

/** A pretend request, so the real one looks familiar. Nothing is shared or sent. */
function Practice({ helperName, onNext }: { helperName: string; onNext(): void }) {
  const [stage, setStage] = useState<PracticeStage>('asked');

  return (
    <div className="setup-card practice" data-testid="practice">
      <h2 id="setup-title">Practise once</h2>
      <p className="hint">This is only practice: nothing is shared.</p>
      {stage === 'asked' && (
        <div className="card consent" role="group" aria-label="Practice question">
          <div className="avatar" aria-hidden="true">
            {helperName.slice(0, 1).toUpperCase()}
          </div>
          <h3>{helperName} would like to help you</h3>
          <p>
            When your helper asks, this question appears and your computer makes a sound. Try saying
            yes.
          </p>
          <button type="button" className="primary big" onClick={() => setStage('live')}>
            Yes, let {helperName} help
          </button>
          <button type="button" className="secondary big" onClick={() => setStage('said-no')}>
            No, not now
          </button>
        </div>
      )}
      {stage === 'said-no' && (
        <div className="card">
          <p className="status">That&apos;s fine: saying no is always safe.</p>
          <p>Your helper is told, and nothing is shared. Now try saying yes.</p>
          <button type="button" className="primary big" onClick={() => setStage('asked')}>
            Try again
          </button>
        </div>
      )}
      {(stage === 'live' || stage === 'paused') && (
        <div className="card">
          <p>
            While someone helps, this bar stays at the top of your screen, and a coloured frame
            shows that your screen is being shared.
          </p>
          <div
            className={stage === 'paused' ? 'practice-bar paused' : 'practice-bar'}
            data-testid="practice-bar"
          >
            <span className="practice-bar-status">
              {stage === 'paused'
                ? `Paused: ${helperName} can't see your screen`
                : `${helperName} is helping you`}
            </span>
            <button
              type="button"
              className="secondary"
              onClick={() => setStage(stage === 'paused' ? 'live' : 'paused')}
            >
              {stage === 'paused' ? 'Continue' : 'Pause'}
            </button>
            <button type="button" className="danger" onClick={() => setStage('stopped')}>
              Stop
            </button>
          </div>
          <p className="hint">
            {stage === 'paused'
              ? 'Paused: your helper sees a "paused" picture. Press Continue, then Stop.'
              : 'Pause hides your screen for a moment. Stop ends the help. Try Pause.'}
          </p>
        </div>
      )}
      {stage === 'stopped' && (
        <div className="card">
          <p className="status" data-testid="practice-done">
            Well done. That&apos;s all there is to it.
          </p>
          <p>When you press Stop, your helper can no longer see or use your computer.</p>
          <button type="button" className="primary big" onClick={onNext}>
            Continue
          </button>
        </div>
      )}
      {stage !== 'stopped' && (
        <button type="button" className="link" onClick={onNext}>
          Skip the practice
        </button>
      )}
    </div>
  );
}

function Done({ onFinish }: { onFinish(): void }) {
  return (
    <div className="card setup-card">
      <h2 id="setup-title">You&apos;re all set</h2>
      <p>
        You can close this window. Remote Assist keeps waiting at the top of the screen, as a small
        circle next to the clock.
      </p>
      <p>When your helper asks, this window comes back by itself and asks you first.</p>
      <button type="button" className="primary big" onClick={onFinish}>
        Finish
      </button>
    </div>
  );
}
