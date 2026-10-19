import type { PeopleState, TrustedPeer } from '@remote-assist/desktop/channels';
import { formatSessionCode } from '@remote-assist/protocol';
import { useEffect, useState } from 'react';
import type { AppConfig, SessionOutcome, SessionRecord } from '../../shared/api';

/** The start screen: who can help, how to pair, and what happened recently. */
export function Home({
  config,
  people,
  onCodeSession,
}: {
  config: AppConfig;
  people: PeopleState;
  onCodeSession(): void;
}) {
  const helpers = people.peers.filter((peer) => peer.role === 'helper');
  const online = people.connection === 'online';
  const pair = () => void window.hostApi.startPairing();

  return (
    <>
      {!online && (
        <p className="warning" role="status" data-testid="connection">
          {people.connection === 'connecting'
            ? 'Connecting…'
            : "Not connected to the internet. Your helpers can't reach you right now."}
        </p>
      )}

      {helpers.length === 0 ? (
        <section className="card">
          <h2>Pair with your helper</h2>
          <p>
            Do this once, together on the phone or side by side. Afterwards your helper can ask to
            help you, and you decide every time.
          </p>
          <button type="button" className="primary big" onClick={pair} disabled={!online}>
            Pair with my helper
          </button>
        </section>
      ) : (
        <section className="card">
          <h2>People who can help you</h2>
          <PeopleList helpers={helpers} />
          <p className="hint">When one of them wants to help, you will be asked first.</p>
          <button type="button" className="secondary" onClick={pair} disabled={!online}>
            Add another helper
          </button>
        </section>
      )}

      {config.allowCodeSessions && (
        <button type="button" className="secondary" onClick={onCodeSession} disabled={!online}>
          Get help with a one-time code
        </button>
      )}
      <RecentSessions />
      <p className="hint footnote">
        You can close this window. Remote Assist keeps waiting at the top of the screen, as a small
        circle next to the clock, and comes back when someone asks to help.
      </p>
    </>
  );
}

function PeopleList({ helpers }: { helpers: TrustedPeer[] }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <ul className="people" data-testid="helpers">
      {helpers.map((helper) => (
        <li key={helper.id}>
          <span className={helper.online ? 'presence online' : 'presence'} aria-hidden="true" />
          <span className="person">
            <strong>{helper.name}</strong>
            <span className="hint">{helper.online ? 'Can help now' : 'Not online'}</span>
          </span>
          {confirming === helper.id ? (
            <span className="confirm-remove">
              <span>Remove {helper.name}? They won&apos;t be able to help you any more.</span>
              <button
                type="button"
                className="danger"
                onClick={() => void window.hostApi.removePeer(helper.id)}
              >
                Remove
              </button>
              <button type="button" className="secondary" onClick={() => setConfirming(null)}>
                Keep
              </button>
            </span>
          ) : (
            <button type="button" className="secondary" onClick={() => setConfirming(helper.id)}>
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Pairing, step by step, as the main process reports it. */
export function PairingView({ people }: { people: PeopleState }) {
  const { pairing } = people;
  const close = () => void window.hostApi.cancelPairing();

  switch (pairing.step) {
    case 'idle':
      return null;
    case 'code':
      return (
        <section className="card" data-testid="pairing">
          <h2>Read this number to your helper</h2>
          <p className="session-code" data-testid="pairing-code">
            {formatSessionCode(pairing.code)}
          </p>
          <p className="hint">
            {pairing.needsApproval
              ? 'Because someone already helps you, one of them will be asked to approve.'
              : 'It works once, for the next 10 minutes.'}
          </p>
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
        </section>
      );
    case 'redeeming':
    case 'waiting-approval':
      return (
        <section className="card" data-testid="pairing">
          <p className="status" data-testid="pairing-status">
            {pairing.step === 'waiting-approval'
              ? 'Waiting for one of your helpers to approve…'
              : 'Connecting…'}
          </p>
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
        </section>
      );
    case 'confirm':
      return (
        <section className="card consent" data-testid="pairing">
          <h2>Check these three words with {pairing.peer.name}</h2>
          <p className="words" data-testid="pairing-words">
            {pairing.words.join(' · ')}
          </p>
          <p>Does {pairing.peer.name} see exactly the same three words?</p>
          <button
            type="button"
            className="primary big"
            onClick={() => void window.hostApi.confirmPairing(true)}
          >
            Yes, they match
          </button>
          <button
            type="button"
            className="secondary big"
            onClick={() => void window.hostApi.confirmPairing(false)}
          >
            No, they are different
          </button>
        </section>
      );
    case 'confirmed':
      return (
        <section className="card" data-testid="pairing">
          <p className="status" data-testid="pairing-status">
            Waiting for {pairing.peer.name} to check the words too…
          </p>
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
        </section>
      );
    case 'done':
      return (
        <section className="card" data-testid="pairing">
          <p className="status" data-testid="pairing-status">
            {pairing.peer.name} can now help you. You will be asked each time.
          </p>
          <button type="button" className="primary" onClick={close}>
            Done
          </button>
        </section>
      );
    case 'failed':
      return (
        <section className="card" data-testid="pairing">
          <p role="alert" className="error" data-testid="pairing-status">
            {pairing.message}
          </p>
          <button type="button" className="primary" onClick={close}>
            Done
          </button>
        </section>
      );
  }
}

const OUTCOMES: Record<SessionOutcome, string> = {
  declined: 'you said no',
  unanswered: 'not answered',
  stopped: 'you stopped it',
  'helper-left': 'they finished',
  locked: 'ended when the screen locked',
  idle: 'ended: no activity',
  'time-limit': 'ended: time limit',
  lost: 'connection lost',
  error: 'could not start',
};

/** Every request, accepted or not, so nothing happens without a trace. */
function RecentSessions() {
  const [records, setRecords] = useState<SessionRecord[]>([]);
  useEffect(() => {
    void window.hostApi.sessionHistory().then(setRecords);
  }, []);
  if (records.length === 0) return null;
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <section className="history" aria-labelledby="history-title">
      <h2 id="history-title">Recent requests</h2>
      <ul data-testid="history">
        {records.slice(0, 5).map((record) => (
          <li key={`${record.askedAt}-${record.endedAt}`}>
            <span className="history-when">{when.format(record.askedAt)}</span>
            <span>
              <strong>{record.helperName}</strong>: {OUTCOMES[record.outcome]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
