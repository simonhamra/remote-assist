import { useEffect, useState, type FormEvent } from 'react';

interface CodeBoxProps {
  value: string;
  testId: string;
  label: string;
  onCopy: (text: string) => Promise<void>;
}

/** A read-only code with a Copy button. */
export function CodeBox({ value, testId, label, onCopy }: CodeBoxProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="code-box">
      <textarea
        readOnly
        value={value}
        data-testid={testId}
        rows={4}
        onFocus={(event) => event.currentTarget.select()}
        aria-label={label}
      />
      <button
        type="button"
        className="primary"
        onClick={() => void onCopy(value).then(() => setCopied(true))}
      >
        {copied ? 'Copied ✓' : 'Copy code'}
      </button>
    </div>
  );
}

interface PasteBoxProps {
  testId: string;
  label: string;
  buttonLabel: string;
  onSubmit: (code: string) => Promise<void>;
}

/** A text area for pasting a code, with a submit button. */
export function PasteBox({ testId, label, buttonLabel, onSubmit }: PasteBoxProps) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onSubmit(code);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="code-box" onSubmit={(event) => void submit(event)}>
      <textarea
        value={code}
        onChange={(event) => setCode(event.target.value)}
        data-testid={testId}
        rows={4}
        placeholder="Paste the code here"
        aria-label={label}
      />
      <button type="submit" className="primary" disabled={busy || code.trim() === ''}>
        {busy ? 'Working…' : buttonLabel}
      </button>
    </form>
  );
}
