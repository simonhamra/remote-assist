import { SignalCodeError } from '@remote-assist/rtc';
import { useCallback, useEffect, useState } from 'react';
import type { AppConfig } from '../../shared/api';
import { CodeBox, PasteBox } from './CodeFields';
import { HelperSession } from './helperSession';
import { Viewer } from './Viewer';

type Step =
  | { name: 'paste' }
  | { name: 'reply'; session: HelperSession }
  | { name: 'viewing'; session: HelperSession }
  | { name: 'ended'; message: string };

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [step, setStep] = useState<Step>({ name: 'paste' });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [connection, setConnection] = useState<RTCPeerConnectionState>('new');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.helperApi.getConfig().then(setConfig);
  }, []);

  const session = step.name === 'reply' || step.name === 'viewing' ? step.session : null;

  const end = useCallback((ending: HelperSession, message: string) => {
    ending.close();
    setStream(null);
    setStep({ name: 'ended', message });
  }, []);

  useEffect(() => {
    if (!session) return;
    const onState = () => {
      const state = session.pc.connectionState;
      setConnection(state);
      if (state === 'connected') {
        setStep((current) => (current.name === 'reply' ? { name: 'viewing', session } : current));
      } else if (state === 'failed') {
        end(session, 'The connection was lost.');
      }
    };
    session.pc.addEventListener('connectionstatechange', onState);
    return () => session.pc.removeEventListener('connectionstatechange', onState);
  }, [session, end]);

  const connect = async (code: string) => {
    setError(null);
    setConnection('new');
    let created: HelperSession | null = null;
    try {
      created = await HelperSession.fromInvite(code, {
        onStream: setStream,
        onHostEnded: () => {
          if (created) end(created, 'They stopped sharing their screen.');
        },
      });
      setStep({ name: 'reply', session: created });
    } catch (inviteError) {
      console.error(inviteError);
      setError(
        inviteError instanceof SignalCodeError
          ? inviteError.message
          : `This invite code could not be used: ${String(inviteError)}`,
      );
    }
  };

  if (step.name === 'viewing' && config) {
    return (
      <Viewer
        pc={step.session.pc}
        stream={stream}
        fakeScreen={config.fakeScreen}
        connection={connection}
        onDisconnect={() => end(step.session, 'You disconnected.')}
      />
    );
  }

  return (
    <main className="panel">
      <header>
        <h1>Help someone</h1>
        <p className="lead">
          Ask them to press “Start sharing my screen” in Remote Assist, then swap the two codes.
        </p>
        {config?.fakeScreen && <p className="badge">Test mode: the host shares a fake screen</p>}
      </header>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {step.name === 'paste' && (
        <section className="card">
          <h2>
            <span className="step-number">1</span> Paste their invite code
          </h2>
          <PasteBox
            testId="invite-input"
            label="Invite code"
            buttonLabel="Connect"
            onSubmit={connect}
          />
        </section>
      )}

      {step.name === 'reply' && (
        <>
          <section className="card">
            <h2>
              <span className="step-number">2</span> Send this reply code back
            </h2>
            <CodeBox
              value={step.session.replyCode}
              testId="reply-code"
              label="Reply code"
              onCopy={window.helperApi.copyText}
            />
            <p className="hint" data-testid="status">
              Waiting for them to paste it…
            </p>
          </section>
          <button
            type="button"
            className="secondary"
            onClick={() => end(step.session, 'Cancelled.')}
          >
            Cancel
          </button>
        </>
      )}

      {step.name === 'ended' && (
        <section className="card">
          <p className="status" data-testid="status">
            {step.message}
          </p>
          <button
            type="button"
            className="primary"
            onClick={() => {
              setError(null);
              setStep({ name: 'paste' });
            }}
          >
            Start over
          </button>
        </section>
      )}
    </main>
  );
}
