import { useState } from 'react';

const KEY = 'shaddai.explainer.dismissed';

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** First-time explainer: one screen, not a blog. */
export function Explainer() {
  const [dismissed, setDismissed] = useState(read);
  if (dismissed) return null;
  const close = () => {
    setDismissed(true);
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* private mode: stays dismissed for this visit */
    }
  };
  return (
    <aside className="explainer" aria-label="How to read this statement">
      <div className="wrap">
        <div>
          <p className="big">Your wallet counts tokens. Shaddai counts shares.</p>
          <p>
            After a dividend the contract keeps the same raw number and raises a multiplier. The extra amount is the
            reinvested dividend after withholding. It is not a glitch and it is not cash you can spend.
          </p>
        </div>
        <button type="button" className="btn" onClick={close}>
          Got it
        </button>
      </div>
    </aside>
  );
}
