import type { PeopleState, TrustedPeer } from '@remote-assist/desktop/channels';
import { displayName, normalizeSessionCode } from '@remote-assist/protocol';
import { useState, type FormEvent } from 'react';

/** First thing: the name the people you help will see when you pair and when you ask. */
export function NameForm({ initial }: { initial: string }) {
  const [name, setName] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = displayName.safeParse(name);
    if (!parsed.success) {
      setProblem('Enter a name of 1 to 40 characters.');
      return;
    }
    void window.helperApi.setName(parsed.data);
  };
  return (
    <form className="card" onSubmit={submit}>
      <h2>What is your name?</h2>
      <p className="hint">
        The people you help see it when you pair and each time you ask to help.
      </p>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <input
        className="text-input"
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={40}
        autoFocus
        aria-label="Your name"
        data-testid="name-input"
      />
      <button type="submit" className="primary">
        Continue
      </button>
    </form>
  );
}

export function PeopleList({
  people,
  onHelp,
}: {
  people: PeopleState;
  onHelp(peer: TrustedPeer): void;
}) {
  const hosts = people.peers.filter((peer) => peer.role === 'host');
  const [confirming, setConfirming] = useState<string | null>(null);
  if (hosts.length === 0) {
    return <p className="hint">You haven't paired with anyone yet.</p>;
  }
  const online = people.connection === 'online';
  return (
    <ul className="people" data-testid="hosts">
      {hosts.map((host) => (
        <li key={host.id}>
          <span className={host.online ? 'presence online' : 'presence'} aria-hidden="true" />
          <span className="person">
            <strong>{host.name}</strong>
            <span className="hint">{host.online ? 'Online' : 'Not online'}</span>
          </span>
          {confirming === host.id ? (
            <span className="confirm-remove">
              Remove {host.name}? You'll have to pair again to help them.
              <button
                type="button"
                className="danger"
                onClick={() => void window.helperApi.removePeer(host.id)}
              >
                Remove
              </button>
              <button type="button" onClick={() => setConfirming(null)}>
                Keep
              </button>
            </span>
          ) : (
            <>
              <button
                type="button"
                className="primary"
                disabled={!online || !host.online}
                onClick={() => onHelp(host)}
              >
                Help {host.name}
              </button>
              <button type="button" onClick={() => setConfirming(host.id)}>
                Remove
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Someone new wants to pair with a computer you help: you approve, or refuse. */
export function Approvals({ people }: { people: PeopleState }) {
  if (people.approvals.length === 0) return null;
  return (
    <>
      {people.approvals.map((approval) => (
        <section
          className="card notice-card"
          key={`${approval.host}-${approval.helper.id}`}
          data-testid="approval"
        >
          <h2>
            {approval.helper.name} wants to pair with {approval.hostName}'s computer
          </h2>
          <p className="hint">
            Only approve if you know about this. A stranger asking {approval.hostName} for a code is
            how scams start.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="primary"
              onClick={() =>
                void window.helperApi.answerApproval(approval.host, approval.helper.id, true)
              }
            >
              Approve
            </button>
            <button
              type="button"
              className="danger"
              onClick={() =>
                void window.helperApi.answerApproval(approval.host, approval.helper.id, false)
              }
            >
              Refuse
            </button>
          </div>
        </section>
      ))}
    </>
  );
}

/** Pairing from the helper's side: type the code, compare the words, name the person. */
export function PairingFlow({ people, onClose }: { people: PeopleState; onClose(): void }) {
  const { pairing } = people;
  const close = () => {
    void window.helperApi.cancelPairing();
    onClose();
  };

  switch (pairing.step) {
    case 'idle':
      return <PairingCodeForm onCancel={close} />;
    case 'code':
    case 'redeeming':
    case 'waiting-approval':
      return (
        <section className="card" data-testid="pairing">
          <p className="status" data-testid="pairing-status">
            {pairing.step === 'waiting-approval'
              ? 'Someone already helps this person: waiting for them to approve you…'
              : 'Connecting…'}
          </p>
          <button type="button" onClick={close}>
            Cancel
          </button>
        </section>
      );
    case 'confirm':
      return (
        <section className="card" data-testid="pairing">
          <h2>Check these three words with {pairing.peer.name}</h2>
          <p className="words" data-testid="pairing-words">
            {pairing.words.join(' · ')}
          </p>
          <p>
            Read them out. If anything differs, say no: someone may be trying to get in between you.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="primary"
              onClick={() => void window.helperApi.confirmPairing(true)}
            >
              They match
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => void window.helperApi.confirmPairing(false)}
            >
              They are different
            </button>
          </div>
        </section>
      );
    case 'confirmed':
      return (
        <section className="card" data-testid="pairing">
          <p className="status" data-testid="pairing-status">
            Waiting for {pairing.peer.name} to confirm on their screen…
          </p>
          <button type="button" onClick={close}>
            Cancel
          </button>
        </section>
      );
    case 'done':
      return <NamePeer peer={pairing.peer} onDone={close} />;
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

function PairingCodeForm({ onCancel }: { onCancel(): void }) {
  const [input, setInput] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const code = normalizeSessionCode(input);
    if (code.length !== 8) {
      setProblem('The code has 8 digits.');
      return;
    }
    try {
      await window.helperApi.redeemPairing(code);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <form className="card" onSubmit={(event) => void submit(event)} data-testid="pairing">
      <h2>Pair with someone</h2>
      <p className="hint">
        On their computer, they press "Pair with my helper" and read you the number.
      </p>
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
        autoFocus
        placeholder="1234 5678"
        aria-label="Pairing code"
        data-testid="pairing-code-input"
      />
      <div className="button-row">
        <button type="submit" className="primary" disabled={!normalizeSessionCode(input)}>
          Pair
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** After pairing: what you call this person (their computer suggested a name). */
function NamePeer({ peer, onDone }: { peer: TrustedPeer; onDone(): void }) {
  const [name, setName] = useState(peer.name);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = displayName.safeParse(name);
    if (parsed.success && parsed.data !== peer.name) {
      await window.helperApi.renamePeer(peer.id, parsed.data);
    }
    onDone();
  };
  return (
    <form className="card" onSubmit={(event) => void save(event)} data-testid="pairing">
      <p className="status" data-testid="pairing-status">
        Paired. You can now ask to help.
      </p>
      <label className="field">
        What do you call them?
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} />
      </label>
      <button type="submit" className="primary">
        Done
      </button>
    </form>
  );
}
