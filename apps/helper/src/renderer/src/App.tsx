import type { PeopleState } from '@remote-assist/desktop/channels';
import { normalizeSessionCode } from '@remote-assist/protocol';
import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { AppConfig } from '../../shared/api';
import { HelperSession, type HelperSessionOptions, type HelperState } from './helperSession';
import { Approvals, NameForm, PairingFlow, PeopleList } from './People';
import { Viewer } from './Viewer';

const noSubscription = () => () => {};
const noState = () => null;

function useSessionState(session: HelperSession | null): HelperState | null {
  return useSyncExternalStore(
    session ? session.subscribe : noSubscription,
    session ? session.getState : noState,
  );
}

/** The people this helper is paired with, kept up to date by the main process. */
function usePeople(): PeopleState | null {
  const [people, setPeople] = useState<PeopleState | null>(null);
  useEffect(() => {
    const stop = window.helperApi.onPeople(setPeople);
    void window.helperApi.getPeople().then(setPeople);
    return stop;
  }, []);
  return people;
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [session, setSession] = useState<HelperSession | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const state = useSessionState(session);
  const people = usePeople();

  useEffect(() => {
    void window.helperApi.getConfig().then(setConfig);
  }, []);

  if (session && state?.name === 'live' && config) {
    const pc = session.peerConnection;
    if (pc) {
      return <Viewer session={session} state={state} pc={pc} fakeScreen={config.fakeScreen} />;
    }
  }

  if (!config || !people) return null;
  const options: HelperSessionOptions = {
    forceRelay: config.forceRelay,
    machine: config.machine,
    name: people.name,
  };
  const connecting =
    state?.name === 'contacting' || state?.name === 'waiting' || state?.name === 'connecting';
  const endedAfterLive = state?.name === 'ended' && state.wasLive;
  // A failed attempt goes back to the start screen, with the reason.
  const failure = state?.name === 'ended' && !state.wasLive ? state.message : null;
  const pairing = pairingOpen || people.pairing.step !== 'idle';

  return (
    <main className="panel">
      <header>
        <h1>Help someone</h1>
        <p className="lead">The people you pair with can let you see and use their screen.</p>
        {config.fakeScreen && <p className="badge">Test mode: the host shares a fake screen</p>}
      </header>

      {people.connection !== 'online' && (
        <p className="warning" role="status" data-testid="connection">
          {people.connection === 'connecting'
            ? 'Connecting…'
            : 'Not connected to the Remote Assist server.'}
        </p>
      )}

      {!people.named ? (
        <NameForm initial="" />
      ) : connecting && session ? (
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
      ) : endedAfterLive ? (
        <section className="card">
          <p className="status" data-testid="status">
            {state.message}
          </p>
          <button type="button" className="primary" onClick={() => setSession(null)}>
            Start over
          </button>
        </section>
      ) : pairing ? (
        <PairingFlow people={people} onClose={() => setPairingOpen(false)} />
      ) : (
        <>
          {failure && (
            <p role="alert" className="error">
              {failure}
            </p>
          )}
          <Approvals people={people} />
          <section className="card">
            <h2>People you help</h2>
            <PeopleList
              people={people}
              onHelp={(peer) => setSession(HelperSession.request(peer.id, options))}
            />
            <button type="button" className="secondary" onClick={() => setPairingOpen(true)}>
              Pair with someone
            </button>
          </section>
          {config.allowCodeSessions && (
            <CodeForm onJoin={(code) => setSession(HelperSession.join(code, options))} />
          )}
        </>
      )}
    </main>
  );
}

/** One-time code sessions, for development and tests (normal use goes through pairing). */
function CodeForm({ onJoin }: { onJoin(code: string): void }) {
  const [input, setInput] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

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
      <h2>Help with a one-time code</h2>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <input
        className="code-input"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        inputMode="numeric"
        autoComplete="off"
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
