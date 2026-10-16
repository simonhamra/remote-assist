import { SignalCodeError } from '@remote-assist/rtc';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppConfig, ScreenPermission } from '../../shared/api';
import { CodeBox, PasteBox } from './CodeFields';
import { HostSession } from './hostSession';
import { HostStats } from './HostStats';

type Step =
  | { name: 'idle' }
  | { name: 'starting' }
  | { name: 'invite'; session: HostSession; replied: boolean }
  | { name: 'live'; session: HostSession }
  | { name: 'ended'; message: string };

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [permission, setPermission] = useState<ScreenPermission>('unknown');
  const [step, setStep] = useState<Step>({ name: 'idle' });
  const [connection, setConnection] = useState<RTCPeerConnectionState>('new');
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

  const session = step.name === 'invite' || step.name === 'live' ? step.session : null;

  const end = useCallback((ending: HostSession, message: string) => {
    ending.stop();
    setStep({ name: 'ended', message });
  }, []);

  useEffect(() => {
    if (!session) return;
    const onState = () => {
      const state = session.pc.connectionState;
      setConnection(state);
      if (state === 'connected') {
        setStep((current) => (current.name === 'invite' ? { name: 'live', session } : current));
      } else if (state === 'failed') {
        end(session, 'The connection was lost. Start again and send a new invite code.');
      }
    };
    const onTrackEnded = () => end(session, 'Screen sharing was stopped outside the app.');
    session.pc.addEventListener('connectionstatechange', onState);
    session.track.addEventListener('ended', onTrackEnded);
    return () => {
      session.pc.removeEventListener('connectionstatechange', onState);
      session.track.removeEventListener('ended', onTrackEnded);
    };
  }, [session, end]);

  const start = async () => {
    if (!config) return;
    setError(null);
    setConnection('new');
    setStep({ name: 'starting' });
    try {
      const started = await HostSession.start(config.fakeScreen);
      setStep({ name: 'invite', session: started, replied: false });
    } catch (startError) {
      console.error(startError);
      setStep({ name: 'idle' });
      setError(describeStartError(startError));
      void window.hostApi.screenPermission().then(setPermission);
    }
  };

  const connect = async (code: string) => {
    if (step.name !== 'invite') return;
    const inviting = step.session;
    setError(null);
    try {
      await inviting.acceptReply(code);
      // The connection may already be live by now, so only update a step that is still waiting.
      setStep((current) =>
        current.name === 'invite' && current.session === inviting
          ? { ...current, replied: true }
          : current,
      );
    } catch (replyError) {
      console.error(replyError);
      setError(
        replyError instanceof SignalCodeError
          ? replyError.message
          : 'This reply code does not match the current invite. Ask your helper to use the newest invite code.',
      );
    }
  };

  const stop = () => {
    if (session) end(session, 'You stopped sharing your screen.');
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

      {(step.name === 'idle' || step.name === 'starting') && (
        <button
          type="button"
          className="primary big"
          onClick={() => void start()}
          disabled={!config || step.name === 'starting'}
        >
          {step.name === 'starting' ? 'Starting…' : 'Start sharing my screen'}
        </button>
      )}

      {step.name === 'invite' && (
        <>
          <section className="card">
            <h2>
              <span className="step-number">1</span> Send this invite code to your helper
            </h2>
            <CodeBox
              value={step.session.inviteCode}
              testId="invite-code"
              label="Invite code"
              onCopy={window.hostApi.copyText}
            />
          </section>
          <section className="card">
            <h2>
              <span className="step-number">2</span> Paste the reply code from your helper
            </h2>
            {step.replied ? (
              <p className="status" data-testid="status">
                Connecting…
              </p>
            ) : (
              <PasteBox
                testId="reply-input"
                label="Reply code"
                buttonLabel="Connect"
                onSubmit={connect}
              />
            )}
          </section>
          <button type="button" className="secondary" onClick={stop}>
            Cancel
          </button>
        </>
      )}

      {step.name === 'live' && (
        <section className="card live">
          <p className="status live-status" data-testid="status">
            Your screen is being shared
          </p>
          {connection === 'disconnected' && (
            <p className="warning">The connection was interrupted. Trying to reconnect…</p>
          )}
          <Preview stream={step.session.source.stream} />
          <button type="button" className="danger big" onClick={stop} data-testid="stop">
            Stop sharing
          </button>
          <HostStats pc={step.session.pc} />
        </section>
      )}

      {step.name === 'ended' && (
        <section className="card">
          <p className="status" data-testid="status">
            {step.message}
          </p>
          <button type="button" className="primary" onClick={() => setStep({ name: 'idle' })}>
            Share again
          </button>
        </section>
      )}
    </main>
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
