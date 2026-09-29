import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export class MemoryKV implements KV {
  private m = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.m.get(key) as T | undefined;
  }
  async set<T>(key: string, value: T) {
    this.m.set(key, value);
  }
}

/** One JSON file per key under `dir`. bigint values are written as {"$big":"123"}. */
export class FileKV implements KV {
  constructor(private readonly dir: string) {}
  private path(key: string) {
    return join(this.dir, `${key.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`);
  }
  async get<T>(key: string): Promise<T | undefined> {
    try {
      const text = await readFile(this.path(key), 'utf8');
      return JSON.parse(text, (_k, v) =>
        v && typeof v === 'object' && typeof v.$big === 'string' ? BigInt(v.$big) : v,
      ) as T;
    } catch {
      return undefined;
    }
  }
  async set<T>(key: string, value: T): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    await writeFile(
      tmp,
      JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? { $big: v.toString() } : v)),
    );
    await rename(tmp, p);
  }
}

/**
 * Reads from each layer in order and writes to the first. Used on serverless
 * hosts: a writable scratch dir first, then a read-only snapshot shipped with
 * the deployment.
 */
export class LayeredKV implements KV {
  constructor(private readonly layers: KV[]) {
    if (layers.length === 0) throw new Error('LayeredKV needs at least one layer');
  }
  async get<T>(key: string): Promise<T | undefined> {
    for (const l of this.layers) {
      const v = await l.get<T>(key);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  async set<T>(key: string, value: T): Promise<void> {
    await this.layers[0]!.set(key, value);
  }
}

/** Small in-process TTL cache with single-flight. */
export class TtlCache<V> {
  private m = new Map<string, { at: number; p: Promise<V> }>();
  constructor(private readonly ttlMs: number) {}
  get(key: string, make: () => Promise<V>): Promise<V> {
    const hit = this.m.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.p;
    const p = make();
    this.m.set(key, { at: Date.now(), p });
    p.catch(() => {
      if (this.m.get(key)?.p === p) this.m.delete(key);
    });
    return p;
  }
  peek(key: string): Promise<V> | undefined {
    const hit = this.m.get(key);
    return hit && Date.now() - hit.at < this.ttlMs ? hit.p : undefined;
  }
}
