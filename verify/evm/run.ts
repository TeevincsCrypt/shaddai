/**
 * Shaddai against the real BEP-677 reference token.
 *
 * Compiles bnb-chain/bep-677-contracts (ERC8056TokenUpgradeable, vendored in
 * contracts/bep677) with solc 0.8.24, deploys it behind UpgradeableBeacon +
 * BeaconProxy like bStocks, and drives it on an in-process Hardhat EVM through
 * the cases mainnet has not produced yet: an overwritten schedule, a 2-for-1
 * split and a pending change. Every Shaddai answer is checked against the
 * contract's own view functions at the relevant blocks.
 *
 *   npm run verify:evm
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { erc20Abi, scaledUiAbi, TOPICS } from '../../src/core/abi.js';
import { MemoryKV } from '../../src/core/cache.js';
import { Chain } from '../../src/core/chain.js';
import { FeedIndexer } from '../../src/core/events.js';
import { buildLedger } from '../../src/core/ledger.js';
import { probeTokens } from '../../src/core/probe.js';
import type { TokenInfo } from '../../src/core/registry.js';
import { classifyRpcError, StateUnavailableError, type RpcTransport } from '../../src/core/rpc.js';
import type { MultiplierEvent } from '../../src/core/types.js';
import { ONE } from '../../src/core/units.js';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(join(here, 'package.json'));

// ---------------------------------------------------------------- compile
function compile() {
  const solc = req('solc');
  const dir = join(here, 'contracts/bep677');
  const sources: Record<string, { content: string }> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sol'))) {
    sources[`bep677/${f}`] = { content: readFileSync(join(dir, f), 'utf8') };
  }
  sources['Deploy.sol'] = {
    content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";`,
  };
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const findImports = (path: string) => {
    try {
      const p = path.startsWith('@openzeppelin/') ? join(here, 'node_modules', path) : join(here, 'contracts', path);
      return { contents: readFileSync(p, 'utf8') };
    } catch {
      return { error: `not found: ${path}` };
    }
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'));
  const get = (file: string, name: string) => {
    const c = out.contracts[file][name];
    return { abi: c.abi as Abi, bytecode: `0x${c.evm.bytecode.object}` as Hex };
  };
  return {
    version: solc.version() as string,
    token: get('bep677/ERC8056TokenUpgradeable.sol', 'ERC8056TokenUpgradeable'),
    beacon: get('@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol', 'UpgradeableBeacon'),
    proxy: get('@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol', 'BeaconProxy'),
  };
}

// ---------------------------------------------------------------- EVM
type Provider = { request(a: { method: string; params?: unknown[] }): Promise<unknown> };

function transportFor(provider: Provider, label: string, opts: { pruned?: () => bigint } = {}): RpcTransport {
  return {
    label,
    async request<T>(method: string, params: unknown[]): Promise<T> {
      // A pruned node keeps only recent state; this test chain is short, so refuse every read below head.
      if (
        opts.pruned &&
        method === 'eth_call' &&
        params[1] !== 'latest' &&
        BigInt(params[1] as string) < opts.pruned()
      ) {
        throw new StateUnavailableError('missing trie node (simulated pruned node)');
      }
      try {
        return (await provider.request({ method, params })) as T;
      } catch (e) {
        const err = e as { code?: number; message?: string };
        throw classifyRpcError({ code: err.code, message: err.message }, label);
      }
    },
  };
}

async function main() {
  const t0 = Date.now();
  const art = compile();
  console.log(`compiled ERC8056TokenUpgradeable with solc ${art.version}`);

  process.chdir(here);
  const hre = req('hardhat');
  const provider: Provider = hre.network.provider;
  const rpc = <T>(method: string, params: unknown[] = []) => provider.request({ method, params }) as Promise<T>;
  const accounts = (await rpc<string[]>('eth_accounts')).map((a) => getAddress(a));
  const [owner, holder, other] = [accounts[0]!, accounts[1]!, accounts[2]!];

  let clock = Number((await rpc<{ timestamp: Hex }>('eth_getBlockByNumber', ['latest', false])).timestamp) + 100;
  const at = (ts: number) => {
    clock = ts;
    return rpc('evm_setNextBlockTimestamp', [ts]);
  };
  const send = async (from: Address, to: Address | null, data: Hex, ts: number) => {
    await at(ts);
    const hash = await rpc<Hex>('eth_sendTransaction', [{ from, ...(to ? { to } : {}), data, gas: '0xf42400' }]);
    const r = await rpc<{ status: Hex; contractAddress: Address | null; blockNumber: Hex }>(
      'eth_getTransactionReceipt',
      [hash],
    );
    if (r.status !== '0x1') throw new Error(`tx reverted at ${ts}`);
    return { address: r.contractAddress ? getAddress(r.contractAddress) : null, block: BigInt(r.blockNumber) };
  };
  const mineAt = async (ts: number) => {
    await at(ts);
    await rpc('evm_mine', []);
  };
  const call = <T>(to: Address, abi: Abi, fn: string, args: unknown[] = [], block: bigint | 'latest' = 'latest') =>
    rpc<Hex>('eth_call', [
      { to, data: encodeFunctionData({ abi, functionName: fn, args } as never) },
      block === 'latest' ? 'latest' : `0x${block.toString(16)}`,
    ]).then((d) => decodeFunctionResult({ abi, functionName: fn, data: d } as never) as T);

  // Deploy like bStocks: implementation, beacon, proxy.
  const impl = (await send(owner, null, art.token.bytecode, clock + 10)).address!;
  const beacon = (
    await send(
      owner,
      null,
      encodeDeployData({ abi: art.beacon.abi, bytecode: art.beacon.bytecode, args: [impl, owner] }),
      clock + 10,
    )
  ).address!;
  const init = encodeFunctionData({
    abi: art.token.abi,
    functionName: 'initialize',
    args: ['Test NVIDIA', 'TNVDAB', 1_000_000n, owner],
  });
  const token = (
    await send(
      owner,
      null,
      encodeDeployData({ abi: art.proxy.abi, bytecode: art.proxy.bytecode, args: [beacon, init] }),
      clock + 10,
    )
  ).address!;
  const deployBlock = BigInt(await rpc<Hex>('eth_blockNumber'));

  const tx = (from: Address, fn: string, args: unknown[], ts: number) =>
    send(from, token, encodeFunctionData({ abi: art.token.abi, functionName: fn, args } as never), ts);
  const u = (v: string) => parseUnits(v, 18);
  const mul = (m: bigint, f: string) => (m * u(f)) / ONE;

  // Scenario, using NVDAB's real September numbers for the first dividend.
  const m1 = 1_000778223752807865n;
  await tx(owner, 'transfer', [holder, u('100')], clock + 100);
  const T1 = clock + 1000;
  await tx(owner, 'setUIMultiplier', [m1, BigInt(T1 + 290)], T1); // dividend, 290 s notice like mainnet
  await mineAt(T1 + 300);
  await tx(holder, 'transfer', [other, u('30')], T1 + 500); // holder now 70

  const T2 = T1 + 2000;
  const mA = mul(m1, '1.002');
  const mB = mul(m1, '1.0021');
  await tx(owner, 'setUIMultiplier', [mA, BigInt(T2 + 3600)], T2); // scheduled...
  await tx(owner, 'setUIMultiplier', [mB, BigInt(T2 + 1800)], T2 + 60); // ...overwritten and accelerated
  await mineAt(T2 + 1900);

  const T3 = T2 + 5000;
  const mSplit = mB * 2n;
  await tx(owner, 'setUIMultiplier', [mSplit, BigInt(T3 + 600)], T3); // 2-for-1 split
  await tx(other, 'transfer', [holder, u('10')], T3 + 300); // holder 80 when the split lands
  await mineAt(T3 + 700);

  const T4 = T3 + 2000;
  const mPending = mul(mSplit, '1.0005');
  await tx(owner, 'setUIMultiplier', [mPending, BigInt(T4 + 86_400)], T4); // still pending at head
  await mineAt(T4 + 10);

  // ------------------------------------------------------------ Shaddai
  const head = BigInt(await rpc<Hex>('eth_blockNumber'));
  const headTs = clock;
  const info: TokenInfo = {
    symbol: 'TNVDAB',
    ticker: 'TNVDA',
    name: 'Test NVIDIA',
    issuer: 'bStocks',
    address: token,
    model: 'bep677',
  };
  const results: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });

  const run = async (chain: Chain) => {
    const feed = new FeedIndexer(chain, [info], new MemoryKV(), async () => deployBlock - 1n);
    await feed.refresh({ number: head, timestamp: headTs });
    const tl = feed.timeline(headTs).sort((a, b) => a.scheduledAt - b.scheduledAt || a.logIndex - b.logIndex);
    const probes = await probeTokens(chain, [info], holder, head, headTs);
    const rows = await buildLedger({
      chain,
      holder,
      head: { number: head, timestamp: headTs },
      events: tl,
      probes,
      prices: new Map(),
      protocolExposure: new Map(),
    });
    return { tl, probes, rows };
  };

  const archive = await run(new Chain(transportFor(provider, 'hardhat'), { multicall: null }));
  const { tl, probes, rows } = archive;
  const s = (e: MultiplierEvent) => `${e.kind}/${e.status} ${e.oldMultiplier}→${e.newMultiplier}`;
  console.log('\ntimeline decoded by Shaddai:');
  for (const e of tl) console.log(`  block ${e.scheduledBlock}  ${s(e)}  effective block ${e.effectiveBlock ?? '-'}`);

  const expectKinds = [
    ['init', 'effective'],
    ['dividend-reinvest', 'effective'],
    ['dividend-reinvest', 'overwritten'],
    ['dividend-reinvest', 'effective'],
    ['split', 'effective'],
    ['dividend-reinvest', 'pending'],
  ];
  check(
    'timeline kinds and statuses',
    JSON.stringify(tl.map((e) => [e.kind, e.status])) === JSON.stringify(expectKinds),
    tl.map((e) => `${e.kind}/${e.status}`).join(', '),
  );
  check('split labelled 2-for-1', tl[4]?.splitLabel === '2-for-1', String(tl[4]?.splitLabel));
  check(
    'every event decoded as the 3-word layout',
    tl.every((e) => e.eventLayout === 'bep677-3'),
  );
  check(
    'overwriting event carries the pre-overwrite multiplier as old',
    tl[3]?.oldMultiplier === tl[1]?.newMultiplier,
    `${tl[3]?.oldMultiplier} vs ${tl[1]?.newMultiplier}`,
  );
  const overwrittenLogs = (
    await rpc<{ topics: Hex[] }[]>('eth_getLogs', [
      { address: token, fromBlock: '0x0', toBlock: 'latest', topics: [TOPICS.multiplierOverwritten] },
    ])
  ).length;
  check('contract emitted UIMultiplierChangeOverwritten once', overwrittenLogs === 1, String(overwrittenLogs));

  // Activation block: the contract's own uiMultiplier() flips exactly there.
  for (const e of tl.filter((x) => x.status === 'effective' && x.kind !== 'init')) {
    const b = BigInt(e.effectiveBlock!);
    const before = await call<bigint>(token, scaledUiAbi, 'uiMultiplier', [], b - 1n);
    const after = await call<bigint>(token, scaledUiAbi, 'uiMultiplier', [], b);
    const oldM = parseUnits(e.oldMultiplier, 18);
    const newM = parseUnits(e.newMultiplier, 18);
    check(
      `uiMultiplier() flips at Shaddai's activation block (${e.kind} ${e.newMultiplier})`,
      before === oldM && after === newM,
      `block ${b - 1n}: ${before}, block ${b}: ${after}`,
    );
  }

  const p = probes.get(token)!;
  const bUI = await call<bigint>(token, scaledUiAbi, 'balanceOfUI', [holder]);
  const eff = await call<bigint>(token, scaledUiAbi, 'effectiveAt');
  check('share-equivalents equal the contract balanceOfUI()', p.shareEq === bUI, `${p.shareEq} vs ${bUI}`);
  check(
    'pending change detected from effectiveAt()',
    p.unit.pending?.multiplier !== undefined &&
      parseUnits(p.unit.pending.multiplier, 18) === mPending &&
      BigInt(p.unit.pending.effectiveAt) === eff,
    JSON.stringify(p.unit.pending),
  );
  check(
    'current multiplier equals uiMultiplier()',
    p.mult === (await call<bigint>(token, scaledUiAbi, 'uiMultiplier')),
  );

  const byNew = (m: bigint) => rows.find((r) => parseUnits(r.newMultiplier, 18) === m && r.status !== 'overwritten')!;
  const expectRaw: [string, bigint, string][] = [
    ['dividend', m1, '100'],
    ['overwriting dividend', mB, '70'],
    ['split', mSplit, '80'],
    ['pending', mPending, '80'],
  ];
  for (const [name, m, raw] of expectRaw) {
    const r = byNew(m);
    const delta = (u(raw) * (parseUnits(r.newMultiplier, 18) - parseUnits(r.oldMultiplier, 18))) / ONE;
    check(
      `ledger raw_at_event and Δ for the ${name}`,
      r.rawAtEvent === raw && parseUnits(r.deltaShareEq!, 18) === delta,
      `raw ${r.rawAtEvent} (${r.rawAtEventSource}), Δ ${r.deltaShareEq}`,
    );
  }
  check('split row carries no USD credit', byNew(mSplit).estUsd === null);

  // Same ledger through a pruned node: Transfer replay must give the same raw balances.
  const pruned = await run(
    new Chain(transportFor(provider, 'hardhat-pruned', { pruned: () => head }), { multicall: null }),
  );
  const pick = (rs: typeof rows) =>
    rs
      .map((r) => `${r.id}:${r.rawAtEvent}:${r.deltaShareEq}`)
      .sort()
      .join('|');
  check(
    'Transfer replay (pruned node) matches archive reads',
    pick(pruned.rows) === pick(rows) &&
      pruned.rows.filter((r) => r.status === 'effective').every((r) => r.rawAtEventSource === 'replay'),
    pruned.rows.map((r) => r.rawAtEventSource).join(','),
  );
  check('holder balance sanity', (await call<bigint>(token, erc20Abi, 'balanceOf', [holder])) === u('80'));

  console.log('\nchecks:');
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (failed) process.exitCode = 1;
}

main().catch((e: Error) => {
  console.error(e.stack ?? e.message);
  process.exitCode = 1;
});
