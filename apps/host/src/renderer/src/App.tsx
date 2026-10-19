import { formatSessionCode } from '@remote-assist/protocol';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AppConfig, ControlStatus, ScreenPermission } from '../../shared/api';
import { HostSession } from './hostSession';
import { HostStats } from './HostStats';

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [permission, setPermission] = useState<ScreenPermission>('unknown');
  const [session, setSession] = useState<HostSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.hostApi.getConfig().then(setConfig);
  }, []);

  useEffect(() => {
    const refresh = () => void window.hostApi.screenPermission().then(setPermission);
    refresh();
    // Coming back from System Settings focuses the window again.
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  const start = async () => {
    if (!config) return;
    setError(null);
    setStarting(true);
    try {
      setSession(await HostSession.start(config));
    } catch (startError) {
      console.error(startError);
      setError(describeStartError(startError));
      void window.hostApi.screenPermission().then(setPermission);
    } finally {
      setStarting(false);
    }
  };

  return (
    <main className="app">
      <header>
        <h1>Share my screen</h1>
        <p className="lead">
          Your helper will see your screen. Nothing is shared until you press the button.
        </p>
        {config?.fakeScreen && <p className="badge">Test mode: a fake screen is shared</p>}
      </header>

      {config && !config.fakeScreen && <PermissionNotice permission={permission} />}

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {session ? (
        <SessionView session={session} onDone={() => setSession(null)} />
      ) : (
        <button
          type="button"
          className="primary big"
          onClick={() => void start()}
          disabled={!config || starting}
        >
          {starting ? 'Starting…' : 'Start sharing my screen'}
        </button>
      )}
    </main>
  );
}

function SessionView({ session, onDone }: { session: HostSession; onDone(): void }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const cancel = () => {
    session.stop();
    onDone();
  };

  switch (state.name) {
    case 'contacting':
    case 'connecting':
      return (
        <section className="card">
          <p className="status" data-testid="status">
            {state.name === 'contacting' ? 'Getting your code…' : 'Your helper is connecting…'}
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
    case 'live': {
      const pc = session.peerConnection;
      return (
        <section className="card live">
          <p className="status live-status" data-testid="status">
            Your screen is being shared
          </p>
          {state.reconnecting && (
            <p className="warning">The connection was interrupted. Trying to reconnect…</p>
          )}
          <ControlNotice session={session} status={state.control} />
          <Preview stream={session.source.stream} />
          <button
            type="button"
            className="danger big"
            onClick={() => session.stop()}
            data-testid="stop"
          >
            Stop sharing
          </button>
          {pc && <HostStats pc={pc} />}
        </section>
      );
    }
    case 'ended':
      return (
        <section className="card">
          <p className="status" data-testid="status">
            {state.message}
          </p>
          <button type="button" className="primary" onClick={onDone}>
            Share again
          </button>
        </section>
      );
  }
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

function describeStartError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'macOS did not allow screen recording. Turn it on in System Settings, then quit and reopen the app.';
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return 'No screen was found to share.';
  }
  return `Screen sharing could not start: ${error instanceof Error ? error.message : String(error)}`;
}
