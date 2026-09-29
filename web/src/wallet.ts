/** Minimal EIP-1193 wallet calls for the Buy tab. BSC mainnet only. */

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

const BSC_HEX = '0x38';

export function hasWallet(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { ethereum?: Eip1193 }).ethereum);
}

function provider(): Eip1193 {
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error('No browser wallet found. Install or unlock one, then try again.');
  return eth;
}

export async function connect(): Promise<string> {
  const eth = provider();
  const [addr] = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  if (!addr) throw new Error('The wallet returned no account.');
  const chain = (await eth.request({ method: 'eth_chainId' })) as string;
  if (chain.toLowerCase() !== BSC_HEX) {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BSC_HEX }] });
  }
  return addr;
}

async function onBsc(eth: Eip1193) {
  const chain = (await eth.request({ method: 'eth_chainId' })) as string;
  if (chain.toLowerCase() !== BSC_HEX) throw new Error('Switch the wallet to BNB Smart Chain (chain 56) first.');
}

export async function sendTx(tx: { from: string; to: string; data: string; value: string }): Promise<string> {
  const eth = provider();
  await onBsc(eth);
  return (await eth.request({
    method: 'eth_sendTransaction',
    params: [{ from: tx.from, to: tx.to, data: tx.data, value: `0x${BigInt(tx.value).toString(16)}` }],
  })) as string;
}

/** Polls for a receipt; resolves true on success, false on revert. */
export async function waitForReceipt(hash: string, timeoutMs = 180_000): Promise<boolean> {
  const eth = provider();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = (await eth.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as {
      status?: string;
    } | null;
    if (r?.status) return r.status === '0x1';
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('No receipt after 3 minutes. Check the transaction on BscScan.');
}

export async function signTypedData(from: string, typedDataJson: string): Promise<string> {
  const eth = provider();
  await onBsc(eth);
  return (await eth.request({ method: 'eth_signTypedData_v4', params: [from, typedDataJson] })) as string;
}
