import type { PeopleState } from '@remote-assist/desktop/channels';
import { formatSessionCode } from '@remote-assist/protocol';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AppConfig, ControlStatus, ScreenPermission, SetupState } from '../../shared/api';
import { playChime } from './chime';
import { Home, PairingView } from './Home';
import { HostSession, type HostState } from './hostSession';
import { HostStats } from './HostStats';
import { Setup } from './Setup';

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [permission, setPermission] = useState<ScreenPermission>('unknown');
  const [session, setSession] = useState<HostSession | null>(null);
  const people = usePeople();
  const activeSession = useRef<HostSession | null>(null);

  useEffect(() => {
    void window.hostApi.getConfig().then(setConfig);
    void window.hostApi.setupState().then(setSetup);
  }, []);

  useEffect(() => {
    const refresh = () => void window.hostApi.screenPermission().then(setPermission);
    refresh();
    // Coming back from System Settings focuses the window again.
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  // A paired helper asks to help (the main process has checked the signature): the session
  // starts with the consent question. It must exist before the next message arrives.
  useEffect(() => {
    if (!config) return;
    return window.hostApi.onSessionEvent((event) => {
      if (event.t !== 'verified' || activeSession.current) return;
      const incoming = HostSession.incoming(event.peer, sessionOptions(config));
      activeSession.current = incoming;
      setSession(incoming);
    });
  }, [config]);

  const startCodeSession = () => {
    if (!config || activeSession.current) return;
    const started = HostSession.start(sessionOptions(config));
    activeSession.current = started;
    setSession(started);
  };

  const done = () => {
    activeSession.current = null;
    setSession(null);
  };

  const pairing = people && people.pairing.step !== 'idle';
  const settingUp = !!config && !!setup && !setup.completed && !config.skipSetup;

  return (
    <main className="app">
      <header>
        <h1>Remote Assist</h1>
        {!settingUp && (
          <p className="lead">
            The people you pair with can ask to help you. Nothing is shared until you say yes.
          </p>
        )}
        {config?.fakeScreen && <p className="badge">Test mode: a fake screen is shared</p>}
      </header>

      {config && !config.fakeScreen && !settingUp && <PermissionNotice permission={permission} />}

      {session ? (
        <SessionView session={session} onDone={done} />
      ) : settingUp && config && setup && people ? (
        <Setup
          config={config}
          people={people}
          initialStep={setup.step}
          onDone={() => setSetup({ step: 'done', completed: true })}
        />
      ) : pairing && people ? (
        <PairingView people={people} />
      ) : config && people ? (
        <Home config={config} people={people} onCodeSession={startCodeSession} />
      ) : null}
    </main>
  );
}

function sessionOptions(config: AppConfig) {
  return {
    fakeScreen: config.fakeScreen,
    forceRelay: config.forceRelay,
    limits: config.consentMs ? { consentMs: config.consentMs } : {},
  };
}

/** The people this computer is paired with, kept up to date by the main process. */
function usePeople(): PeopleState | null {
  const [people, setPeople] = useState<PeopleState | null>(null);
  useEffect(() => {
    const stop = window.hostApi.onPeople(setPeople);
    void window.hostApi.getPeople().then(setPeople);
    return stop;
  }, []);
  return people;
}

/** A sound when someone asks, when help starts, and when it ends. */
function useChimes(state: HostState): void {
  const previous = useRef<HostState['name'] | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = state.name;
    if (before === state.name) return;
    if (state.name === 'asking') playChime('ask');
    else if (state.name === 'live') playChime('start');
    else if (state.name === 'ended' && before === 'live') playChime('end');
  }, [state.name]);
}

function SessionView({ session, onDone }: { session: HostSession; onDone(): void }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  useChimes(state);
  const cancel = () => {
    session.stop();
    onDone();
  };

  switch (state.name) {
    case 'contacting':
      return (
        <section className="card">
          <p className="status" data-testid="status">
            Getting your number…
          </p>
          <button type="button" className="secondary" onClick={cancel}>
            Cancel
          </button>
        </section>
      );
    case 'waiting':
      return (
        <section className="card">
          <h2>Read this number to your helper</h2>
          <p className="session-code" data-testid="session-code" aria-live="polite">
            {formatSessionCode(state.code)}
          </p>
          <p className="hint">It works once, for the next 10 minutes.</p>
          <button type="button" className="secondary" onClick={cancel}>
            Cancel
          </button>
        </section>
      );
    case 'asking':
      return <ConsentCard session={session} state={state} />;
    case 'connecting':
      return (
        <section className="card">
          <p className="status" data-testid="status">
            Connecting to {state.helperName}…
          </p>
        </section>
      );
    case 'live':
      return <LiveCard session={session} state={state} />;
    case 'ended':
      return (
        <section className="card">
          <p className="status" data-testid="status">
            {state.message}
          </p>
          <button type="button" className="primary" onClick={onDone}>
            Done
          </button>
        </section>
      );
  }
}

/** The one question that decides whether anything is shared. "No" is always safe. */
function ConsentCard({
  session,
  state,
}: {
  session: HostSession;
  state: Extract<HostState, { name: 'asking' }>;
}) {
  const name = state.helperName;
  return (
    <section
      className="card consent"
      role="alertdialog"
      aria-labelledby="consent-title"
      aria-describedby="consent-details"
      data-testid="consent"
    >
      <div className="avatar" aria-hidden="true">
        {name.slice(0, 1).toUpperCase()}
      </div>
      <h2 id="consent-title">{name} would like to help you</h2>
      {state.verified && (
        <p className="verified" data-testid="consent-verified">
          ✓ Paired with this computer
        </p>
      )}
      <p id="consent-details">
        {name} will be able to <strong>see your screen</strong> and{' '}
        <strong>use your mouse and keyboard</strong>. You can press <strong>Pause</strong> or{' '}
        <strong>Stop</strong> at any time.
      </p>
      <p className="hint">
        {state.verified
          ? `Say yes if you want ${name}'s help right now.`
          : `This person used a one-time code. Only say yes if you are talking to ${name} right now and you asked for help.`}
      </p>
      <button type="button" className="primary big" onClick={() => void session.accept()}>
        Yes, let {name} help
      </button>
      <button type="button" className="secondary big" onClick={() => session.decline()}>
        No, not now
      </button>
      <p className="hint" data-testid="consent-countdown">
        This question closes by itself in {state.secondsLeft} seconds.
      </p>
    </section>
  );
}

function LiveCard({
  session,
  state,
}: {
  session: HostSession;
  state: Extract<HostState, { name: 'live' }>;
}) {
  const pc = session.peerConnection;
  const screen = session.screen;
  return (
    <section className={state.paused ? 'card live paused' : 'card live'}>
      <p className="status live-status" data-testid="status">
        {state.paused
          ? `Paused: ${state.helperName} can't see or use your screen`
          : `${state.helperName} is helping you`}
      </p>
      {state.reconnecting && (
        <p className="warning">The connection was interrupted. Trying to reconnect…</p>
      )}
      {!state.paused && <ControlNotice session={session} status={state.control} />}
      <div className="button-row">
        <button
          type="button"
          className="secondary big"
          onClick={() => (state.paused ? session.resume() : session.pause())}
          data-testid="pause"
        >
          {state.paused ? 'Continue' : 'Pause'}
        </button>
        <button
          type="button"
          className="danger big"
          onClick={() => session.stop()}
          data-testid="stop"
        >
          Stop
        </button>
      </div>
      {screen && !state.paused && <Preview stream={screen} />}
      {pc && <HostStats pc={pc} />}
    </section>
  );
}

function ControlNotice({
  session,
  status,
}: {
  session: HostSession;
  status: ControlStatus | null;
}) {
  // After switching Accessibility on in System Settings, coming back to the window re-checks it.
  useEffect(() => {
    if (status?.reason !== 'permission') return;
    const recheck = () => void session.refreshControl();
    window.addEventListener('focus', recheck);
    return () => window.removeEventListener('focus', recheck);
  }, [session, status?.reason]);

  if (!status) return null;
  if (status.available) {
    return (
      <p className="hint" data-testid="control-status">
        Your helper can also use your mouse and keyboard.
      </p>
    );
  }
  if (status.reason === 'same-computer') {
    return (
      <p className="hint" data-testid="control-status">
        Your helper is on this same computer, so mouse and keyboard control is off.
      </p>
    );
  }
  if (status.reason === 'unsupported') {
    return (
      <p className="hint" data-testid="control-status">
        Your helper can see your screen. Using your mouse and keyboard isn't available in this
        version.
      </p>
    );
  }
  return (
    <section className="notice" role="status" data-testid="control-status">
      <h2>Let your helper use your mouse and keyboard?</h2>
      <p>
        macOS asks for this once. Open System Settings and switch on Accessibility for this app.
        Your helper can see your screen either way.
      </p>
      <p className="hint">
        During development, macOS lists the app that started Remote Assist (for example Terminal).
      </p>
      <button
        type="button"
        className="secondary"
        onClick={() => void window.hostApi.openAccessibilitySettings()}
      >
        Open System Settings
      </button>
    </section>
  );
}

function PermissionNotice({ permission }: { permission: ScreenPermission }) {
  if (permission === 'not-determined') {
    return (
      <p className="hint">
        The first time you share, macOS asks whether this app may record the screen. Allow it in
        System Settings, then quit and reopen the app.
      </p>
    );
  }
  if (permission !== 'denied' && permission !== 'restricted') return null;
  return (
    <section className="notice" role="status">
      <h2>Screen recording is turned off</h2>
      <p>
        macOS needs your permission before anyone can see your screen. Open System Settings, switch
        on screen recording for this app, then quit and reopen it.
      </p>
      <p className="hint">
        During development, macOS lists the app that started Remote Assist (for example Terminal)
        instead of Remote Assist itself.
      </p>
      <button
        type="button"
        className="secondary"
        onClick={() => void window.hostApi.openScreenRecordingSettings()}
      >
        Open System Settings
      </button>
    </section>
  );
}

function Preview({ stream }: { stream: MediaStream }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream]);
  return (
    <figure className="preview">
      <video ref={video} autoPlay muted playsInline />
      <figcaption>This is what your helper sees</figcaption>
    </figure>
  );
}
