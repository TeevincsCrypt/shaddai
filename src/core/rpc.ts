/**
 * Minimal JSON-RPC layer with endpoint failover.
 *
 * Errors are sorted into three buckets because they need different handling:
 *  - CallRevertedError: deterministic; retrying on another node is pointless.
 *  - StateUnavailableError: historical state pruned on every endpoint tried.
 *  - RpcError: transport / rate-limit / unsupported-method; try the next node.
 */

export interface RpcTransport {
  readonly label: string;
  request<T = unknown>(method: string, params: unknown[]): Promise<T>;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
    readonly endpoint?: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export class CallRevertedError extends RpcError {
  constructor(message: string, code?: number, data?: unknown, endpoint?: string) {
    super(message, code, data, endpoint);
    this.name = 'CallRevertedError';
  }
}

export class StateUnavailableError extends RpcError {
  constructor(message: string, code?: number, data?: unknown, endpoint?: string) {
    super(message, code, data, endpoint);
    this.name = 'StateUnavailableError';
  }
}

const REVERT_RE = /revert|invalid opcode|execution error|VM execution error/i;
const STATE_RE = /missing trie node|header not found|state (is )?not available|historical state|pruned|state histories haven't been fully indexed|required historical state unavailable|unknown block/i;
export const RANGE_RE =
  /range|too many|limit exceeded|exceed|block range|query returned more than|response size|max results|10000 results|timeout|timed out/i;

export function classifyRpcError(err: { code?: number; message?: string; data?: unknown }, endpoint?: string): RpcError {
  const msg = err.message ?? 'unknown RPC error';
  if (err.code === 3 || REVERT_RE.test(msg)) return new CallRevertedError(msg, err.code, err.data, endpoint);
  if (STATE_RE.test(msg)) return new StateUnavailableError(msg, err.code, err.data, endpoint);
  return new RpcError(msg, err.code, err.data, endpoint);
}

export interface HttpTransportOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

let nextId = 1;

export function httpTransport(url: string, opts: HttpTransportOptions = {}): RpcTransport {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const f = opts.fetchImpl ?? fetch;
  const label = new URL(url).host;
  return {
    label,
    async request<T>(method: string, params: unknown[]): Promise<T> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await f(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
          signal: ctrl.signal,
        });
      } catch (e) {
        const msg = (e as Error).name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (e as Error).message;
        throw new RpcError(`${method} via ${label}: ${msg}`, undefined, undefined, label);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new RpcError(`${method} via ${label}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status, undefined, label);
      }
      const body = (await res.json()) as { result?: T; error?: { code?: number; message?: string; data?: unknown } };
      if (body.error) throw classifyRpcError(body.error, label);
      return body.result as T;
    },
  };
}

class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export interface EndpointHealth {
  label: string;
  ok: number;
  failed: number;
  lastError?: string;
  coolingDownUntil?: number;
}

/**
 * Tries each endpoint in order. A failing endpoint cools down briefly so the
 * next request starts with a healthy one. Reverts are rethrown immediately.
 */
export class FallbackTransport implements RpcTransport {
  readonly label: string;
  private readonly sem: Semaphore;
  readonly health: EndpointHealth[];

  constructor(
    private readonly transports: RpcTransport[],
    opts: { concurrency?: number; retries?: number } = {},
  ) {
    if (transports.length === 0) throw new Error('FallbackTransport needs at least one endpoint');
    this.label = transports.map((t) => t.label).join(',');
    this.sem = new Semaphore(opts.concurrency ?? 8);
    this.retries = opts.retries ?? 1;
    this.health = transports.map((t) => ({ label: t.label, ok: 0, failed: 0 }));
  }

  private readonly retries: number;

  async request<T>(method: string, params: unknown[]): Promise<T> {
    return this.sem.run(() => this.attempt<T>(method, params));
  }

  private order(): number[] {
    const now = Date.now();
    const idx = this.transports.map((_, i) => i);
    const cool = (i: number) => (this.health[i]!.coolingDownUntil ?? 0) > now;
    return [...idx.filter((i) => !cool(i)), ...idx.filter(cool)];
  }

  private async attempt<T>(method: string, params: unknown[]): Promise<T> {
    const errors = new Map<string, string>();
    let stateErr: StateUnavailableError | undefined;
    for (let round = 0; round <= this.retries; round++) {
      for (const i of this.order()) {
        const t = this.transports[i]!;
        const h = this.health[i]!;
        try {
          const out = await t.request<T>(method, params);
          h.ok++;
          return out;
        } catch (e) {
          if (e instanceof CallRevertedError) throw e;
          if (e instanceof StateUnavailableError) {
            // Another endpoint may be an archive node; keep trying but remember why.
            stateErr = e;
            continue;
          }
          h.failed++;
          h.lastError = (e as Error).message;
          h.coolingDownUntil = Date.now() + 15_000;
          errors.set(t.label, (e as Error).message);
        }
      }
      if (stateErr) throw stateErr;
      if (round < this.retries) await new Promise((r) => setTimeout(r, 400 * 2 ** round));
    }
    if (errors.size === 1) throw new RpcError([...errors.values()][0]!);
    throw new RpcError(
      `${method}: all ${errors.size} endpoints failed — ${[...errors].map(([l, m]) => `${l}: ${m.replace(`${method} via ${l}: `, '')}`).join(' | ')}`,
    );
  }
}
