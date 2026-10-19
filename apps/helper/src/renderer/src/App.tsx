import { displayName, normalizeSessionCode } from '@remote-assist/protocol';
import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { AppConfig } from '../../shared/api';
import { HelperSession, type HelperState } from './helperSession';
import { Viewer } from './Viewer';

const noSubscription = () => () => {};
const noState = () => null;
const NAME_KEY = 'helperName';

function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Not remembered next time; nothing else depends on it.
  }
}

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
      return <Viewer session={session} state={state} pc={pc} fakeScreen={config.fakeScreen} />;
    }
  }

  const connecting =
    state?.name === 'contacting' || state?.name === 'waiting' || state?.name === 'connecting';
  const endedAfterLive = state?.name === 'ended' && state.wasLive;
  // A failed attempt goes back to the code form, with the reason.
  const failure = state?.name === 'ended' && !state.wasLive ? state.message : null;

  return (
    <main className="panel">
      <header>
        <h1>Help someone</h1>
        <p className="lead">
          Ask them to press “Get help from someone” in Remote Assist and read you the number.
        </p>
        {config?.fakeScreen && <p className="badge">Test mode: the host shares a fake screen</p>}
      </header>

      {connecting && session && (
        <section className="card">
          <p className="status" data-testid="status">
            {state?.name === 'waiting'
              ? 'Waiting for them to say yes on their screen…'
              : 'Connecting…'}
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
        <CodeForm
          error={failure}
          onJoin={(code, name) => setSession(HelperSession.join(code, { ...config, name }))}
        />
      )}
    </main>
  );
}

function CodeForm({
  error,
  onJoin,
}: {
  error: string | null;
  onJoin(code: string, name: string): void;
}) {
  const [input, setInput] = useState('');
  const [name, setName] = useState(savedName);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = problem ?? error;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const code = normalizeSessionCode(input);
    const checkedName = displayName.safeParse(name);
    if (!checkedName.success) {
      setProblem('Enter your name (up to 40 characters): they will see it before saying yes.');
      return;
    }
    if (code.length !== 8) {
      setProblem('The code has 8 digits.');
      return;
    }
    setProblem(null);
    saveName(checkedName.data);
    onJoin(code, checkedName.data);
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Enter the number they read to you</h2>
      {shown && (
        <p role="alert" className="error">
          {shown}
        </p>
      )}
      <label className="field">
        Your name, as they will see it
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          maxLength={40}
          data-testid="name-input"
        />
      </label>
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
