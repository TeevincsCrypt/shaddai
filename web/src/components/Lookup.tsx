import { useState } from 'react';

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export function Lookup(props: {
  initial?: string;
  onScan: (address: string) => void;
  busy: boolean;
  compact?: boolean;
  demoAddress?: string;
}) {
  const [value, setValue] = useState(props.initial ?? '');
  const [walletError, setWalletError] = useState<string | null>(null);
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;

  const connect = async () => {
    setWalletError(null);
    if (!eth) {
      setWalletError('No browser wallet found. Paste the address instead.');
      return;
    }
    try {
      const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
      if (accounts[0]) {
        setValue(accounts[0]);
        props.onScan(accounts[0]);
      }
    } catch (e) {
      setWalletError((e as Error).message || 'The wallet declined the request.');
    }
  };

  return (
    <form
      className="lookup"
      onSubmit={(e) => {
        e.preventDefault();
        props.onScan(value);
      }}
    >
      <label htmlFor="address" className="hide-sm eyebrow" hidden={!props.compact}>
        Address
      </label>
      <input
        id="address"
        name="address"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="0x… BSC address"
        autoComplete="off"
        spellCheck={false}
        aria-label="BSC address"
      />
      <button className="btn primary" type="submit" disabled={props.busy || !value.trim()}>
        {props.busy ? 'Reading…' : 'Read statement'}
      </button>
      <button
        className="btn"
        type="button"
        onClick={connect}
        disabled={props.busy}
        title="Reads your address only. No signatures."
      >
        Use my wallet
      </button>
      {!props.compact ? (
        <button className="btn" type="button" onClick={() => props.onScan('demo')} disabled={props.busy}>
          Open the demo
        </button>
      ) : null}
      {walletError ? (
        <p className="error" style={{ flexBasis: '100%' }}>
          {walletError}
        </p>
      ) : null}
    </form>
  );
}
