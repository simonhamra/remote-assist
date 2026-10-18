import { normalizeSessionCode } from '@remote-assist/protocol';
import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { AppConfig } from '../../shared/api';
import { HelperSession, type HelperState } from './helperSession';
import { Viewer } from './Viewer';

const noSubscription = () => () => {};
const noState = () => null;

function useSessionState(session: HelperSession | null): HelperState | null {
  return useSyncExternalStore(
    session ? session.subscribe : noSubscription,
    session ? session.getState : noState,
  );
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [session, setSession] = useState<HelperSession | null>(null);
  const state = useSessionState(session);

  useEffect(() => {
    void window.helperApi.getConfig().then(setConfig);
  }, []);

  if (session && state?.name === 'live' && config) {
    const pc = session.peerConnection;
    if (pc) {
      return (
        <Viewer
          pc={pc}
          stream={state.stream}
          fakeScreen={config.fakeScreen}
          reconnecting={state.reconnecting}
          onDisconnect={() => session.disconnect()}
        />
      );
    }
  }

  const connecting = state?.name === 'contacting' || state?.name === 'connecting';
  const endedAfterLive = state?.name === 'ended' && state.wasLive;
  // A failed attempt goes back to the code form, with the reason.
  const failure = state?.name === 'ended' && !state.wasLive ? state.message : null;

  return (
    <main className="panel">
      <header>
        <h1>Help someone</h1>
        <p className="lead">
          Ask them to press “Start sharing my screen” in Remote Assist and read you the number.
        </p>
        {config?.fakeScreen && <p className="badge">Test mode: the host shares a fake screen</p>}
      </header>

      {connecting && session && (
        <section className="card">
          <p className="status" data-testid="status">
            Connecting…
          </p>
          <button type="button" className="secondary" onClick={() => session.disconnect()}>
            Cancel
          </button>
        </section>
      )}

      {endedAfterLive && (
        <section className="card">
          <p className="status" data-testid="status">
            {state.message}
          </p>
          <button type="button" className="primary" onClick={() => setSession(null)}>
            Start over
          </button>
        </section>
      )}

      {!connecting && !endedAfterLive && config && (
        <CodeForm error={failure} onJoin={(code) => setSession(HelperSession.join(code, config))} />
      )}
    </main>
  );
}

function CodeForm({ error, onJoin }: { error: string | null; onJoin(code: string): void }) {
  const [input, setInput] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const shown = problem ?? error;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const code = normalizeSessionCode(input);
    if (code.length !== 8) {
      setProblem('The code has 8 digits.');
      return;
    }
    setProblem(null);
    onJoin(code);
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Enter the number they read to you</h2>
      {shown && (
        <p role="alert" className="error">
          {shown}
        </p>
      )}
      <input
        className="code-input"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        inputMode="numeric"
        autoComplete="off"
        autoFocus
        placeholder="1234 5678"
        aria-label="Session code"
        data-testid="code-input"
      />
      <button type="submit" className="primary" disabled={normalizeSessionCode(input).length === 0}>
        Connect
      </button>
    </form>
  );
}
