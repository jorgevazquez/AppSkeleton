#!/usr/bin/env -S npx tsx
/**
 * Kernel plugin-dispatch overhead micro-benchmark for feature #119 ("Kernel
 * plugin-dispatch overhead benchmark").
 *
 * Wired up via `npm run kernel-benchmark` (see package.json). Unlike
 * `scripts/load-test.ts` (feature #110), which drives real HTTP traffic
 * through the whole `api-gateway` + `rbac` + `wiki` request pipeline and
 * needs a live MySQL instance, this script measures exactly two *kernel*
 * primitives in isolation, in-process, with no network and no database:
 *
 *   - {@link createCapabilityBroker}'s `obtain()` call and the `Proxy`-wrapped
 *     handle it returns (broker.ts) — the cost every capability call a
 *     plugin makes pays, on top of whatever the capability's own
 *     implementation does.
 *   - {@link createEventBus}'s `publish()` call (events.ts) — the cost of
 *     fanning one event out to N subscribers, on top of whatever each
 *     subscriber's own handler does.
 *
 * Both are pure CPU-bound, synchronous-or-microtask kernel code with no I/O
 * to wait on, so "under load" here means *sustained call volume* (hundreds
 * of thousands of calls back-to-back) rather than autocannon-style
 * concurrent connections — there is no socket to hold open and no request
 * queue to build up; the in-process analog of load-test.ts's "hammer an
 * endpoint for N seconds at C connections" is "call this kernel primitive N
 * times in a row and measure the steady-state per-call cost", which is what
 * this script does. Every scenario also runs a warmup phase first so the
 * numbers reflect steady-state JIT-optimized performance, not first-call
 * interpreter overhead.
 *
 * Usage:
 *   npm run kernel-benchmark
 *   KERNEL_BENCH_ITERATIONS=1000000 npm run kernel-benchmark
 *
 * Env overrides (all optional, sane defaults below):
 *   KERNEL_BENCH_ITERATIONS  — calls measured per scenario (default 500000)
 *   KERNEL_BENCH_BATCH_SIZE  — calls per timed batch, used to sample
 *                               per-batch latency for p50/p99 (default 1000)
 *   KERNEL_BENCH_WARMUP      — untimed warmup calls before measuring
 *                               (default 5000)
 *
 * See `docs/performance-baseline.md` §6 for the recorded baseline this
 * script produced, how to interpret it, and the overhead budget future
 * plugins should stay within.
 */
import { createCapabilityBroker } from "../src/core/broker.js";
import { createEventBus, type EventMap } from "../src/core/events.js";
import { isOk } from "../src/core/types.js";

const ITERATIONS = Number(process.env["KERNEL_BENCH_ITERATIONS"] ?? 500_000);
const BATCH_SIZE = Number(process.env["KERNEL_BENCH_BATCH_SIZE"] ?? 1_000);
const WARMUP_ITERATIONS = Number(process.env["KERNEL_BENCH_WARMUP"] ?? 5_000);

interface BenchResult {
  readonly name: string;
  readonly opsPerSec: number;
  readonly avgLatencyUs: number;
  readonly p50LatencyUs: number;
  readonly p99LatencyUs: number;
}

/** Nearest-rank percentile over an already-sorted ascending array. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] as number;
}

/**
 * Time `fn` (synchronous, no Promise) across `batches` timed batches of
 * `batchSize` calls each, after `warmup` untimed calls. Batching (rather
 * than timing every single call) keeps `process.hrtime.bigint()`'s own
 * overhead from dominating measurements of calls this cheap, while still
 * yielding one latency-per-op sample per batch to compute p50/p99 from.
 */
function runSyncBenchmark(
  name: string,
  fn: () => void,
  options: { iterations?: number; batchSize?: number; warmup?: number } = {},
): BenchResult {
  const iterations = options.iterations ?? ITERATIONS;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const warmup = options.warmup ?? WARMUP_ITERATIONS;

  for (let i = 0; i < warmup; i++) {
    fn();
  }

  const batches = Math.floor(iterations / batchSize);
  const perOpLatenciesUs: number[] = [];
  let totalNs = 0n;

  for (let b = 0; b < batches; b++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < batchSize; i++) {
      fn();
    }
    const batchNs = process.hrtime.bigint() - start;
    totalNs += batchNs;
    perOpLatenciesUs.push(Number(batchNs) / 1000 / batchSize);
  }

  return summarize(name, batches * batchSize, totalNs, perOpLatenciesUs);
}

/** Same as {@link runSyncBenchmark}, but for an async `fn` (e.g. `bus.publish()`), awaited once per call. */
async function runAsyncBenchmark(
  name: string,
  fn: () => Promise<void>,
  options: { iterations?: number; batchSize?: number; warmup?: number } = {},
): Promise<BenchResult> {
  const iterations = options.iterations ?? ITERATIONS;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const warmup = options.warmup ?? WARMUP_ITERATIONS;

  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  const batches = Math.floor(iterations / batchSize);
  const perOpLatenciesUs: number[] = [];
  let totalNs = 0n;

  for (let b = 0; b < batches; b++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < batchSize; i++) {
      await fn();
    }
    const batchNs = process.hrtime.bigint() - start;
    totalNs += batchNs;
    perOpLatenciesUs.push(Number(batchNs) / 1000 / batchSize);
  }

  return summarize(name, batches * batchSize, totalNs, perOpLatenciesUs);
}

function summarize(
  name: string,
  totalOps: number,
  totalNs: bigint,
  perOpLatenciesUsUnsorted: number[],
): BenchResult {
  const perOpLatenciesUs = [...perOpLatenciesUsUnsorted].sort((a, b) => a - b);
  const avgLatencyUs = Number(totalNs) / 1000 / totalOps;
  const opsPerSec = totalOps / (Number(totalNs) / 1e9);
  return {
    name,
    opsPerSec,
    avgLatencyUs,
    p50LatencyUs: percentile(perOpLatenciesUs, 50),
    p99LatencyUs: percentile(perOpLatenciesUs, 99),
  };
}

function formatTable(results: readonly BenchResult[]): string {
  const header =
    "| Scenario | Ops/s (avg) | Latency avg (µs) | Latency p50 (µs) | Latency p99 (µs) |";
  const divider = "| --- | --- | --- | --- | --- |";
  const rows = results.map(
    (r) =>
      `| ${r.name} | ${r.opsPerSec.toLocaleString("en-US", { maximumFractionDigits: 0 })} | ${r.avgLatencyUs.toFixed(3)} | ${r.p50LatencyUs.toFixed(3)} | ${r.p99LatencyUs.toFixed(3)} |`,
  );
  return [header, divider, ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// Capability broker scenarios
// ---------------------------------------------------------------------------

interface BrokerEvents extends EventMap {
  "bench.event": { i: number };
}

function buildBrokerScenarios(): {
  raw: () => void;
  obtainHotPath: () => void;
  functionHandleInvoke: () => void;
  objectHandleInvoke: () => void;
} {
  const broker = createCapabilityBroker();
  const pluginId = "bench-plugin";
  const fnCapabilityId = "bench:fn";
  const objCapabilityId = "bench:obj";

  let counter = 0;
  const rawFn = (x: number): number => x + 1;
  const objectImplementation = {
    get(x: number): number {
      return x + 1;
    },
  };

  broker.declareRequirements(pluginId, [fnCapabilityId, objCapabilityId]);
  const fnRegistered = broker.registerProvider(pluginId, fnCapabilityId, rawFn);
  const objRegistered = broker.registerProvider(pluginId, objCapabilityId, objectImplementation);
  if (!isOk(fnRegistered) || !isOk(objRegistered)) {
    throw new Error("bench setup: registerProvider failed");
  }
  const fnGranted = broker.grant(pluginId, fnCapabilityId);
  const objGranted = broker.grant(pluginId, objCapabilityId);
  if (!isOk(fnGranted) || !isOk(objGranted)) {
    throw new Error("bench setup: grant failed");
  }

  // Pre-obtained handles, exactly how a real plugin's onEnable() obtains its
  // dependencies once and holds onto the handle for the plugin's lifetime
  // (the documented, recommended pattern — see broker.ts's module docs) —
  // these two scenarios isolate the Proxy invocation cost alone, with no
  // per-call obtain() lookup in the loop.
  const fnHandleResult = broker.obtain<(x: number) => number>(pluginId, fnCapabilityId);
  const objHandleResult = broker.obtain<{ get(x: number): number }>(pluginId, objCapabilityId);
  if (!isOk(fnHandleResult) || !isOk(objHandleResult)) {
    throw new Error("bench setup: obtain failed");
  }
  const fnHandle = fnHandleResult.value;
  const objHandle = objHandleResult.value;

  return {
    // Floor: the same function, called directly, with no broker involved at
    // all — every other broker scenario's overhead is measured relative to
    // this.
    raw: () => {
      counter = rawFn(counter);
    },
    // The cost of obtain() itself, called on every iteration — the pattern a
    // plugin pays for if it re-obtains a capability on every use instead of
    // caching the handle once.
    obtainHotPath: () => {
      const result = broker.obtain<(x: number) => number>(pluginId, fnCapabilityId);
      if (isOk(result)) {
        counter = result.value(counter);
      }
    },
    // The cost of invoking an already-obtained function-shaped handle — the
    // Proxy `apply` trap's `assertLive` check plus `Reflect.apply` (see
    // broker.ts's `wrapHandle`).
    functionHandleInvoke: () => {
      counter = fnHandle(counter);
    },
    // Same, for an object-shaped handle (the `get` trap plus a method
    // rebind) — representative of a service-style capability like
    // `db:query`.
    objectHandleInvoke: () => {
      counter = objHandle.get(counter);
    },
  };
}

// ---------------------------------------------------------------------------
// Event bus scenarios
// ---------------------------------------------------------------------------

function buildEventBusPublisher(subscriberCount: number): () => Promise<void> {
  const bus = createEventBus<BrokerEvents>();
  // Subscribers accumulate into `sink` (rather than being no-ops) so the
  // JIT has a real side effect to perform per dispatch — a truly empty
  // handler body risks being optimized in ways an empty function shouldn't
  // be allowed to understate real dispatch overhead.
  let sink = 0;
  for (let i = 0; i < subscriberCount; i++) {
    bus.subscribe("bench.event", (payload) => {
      sink += payload.i;
    });
  }
  let i = 0;
  return async () => {
    i += 1;
    await bus.publish("bench.event", { i: i + sink * 0 });
  };
}

async function main(): Promise<void> {
  process.stdout.write(
    `-> Running kernel plugin-dispatch benchmark (${ITERATIONS.toLocaleString("en-US")} iterations/scenario, ` +
      `${BATCH_SIZE.toLocaleString("en-US")}/batch, ${WARMUP_ITERATIONS.toLocaleString("en-US")} warmup)...\n`,
  );

  const broker = buildBrokerScenarios();
  const brokerResults: BenchResult[] = [
    runSyncBenchmark("baseline: raw function call (no broker)", broker.raw),
    runSyncBenchmark("broker: obtain() hot path (function capability)", broker.obtainHotPath),
    runSyncBenchmark(
      "broker: pre-obtained handle invocation (function capability)",
      broker.functionHandleInvoke,
    ),
    runSyncBenchmark(
      "broker: pre-obtained handle invocation (object capability)",
      broker.objectHandleInvoke,
    ),
  ];

  const eventBusResults: BenchResult[] = [];
  for (const subscriberCount of [0, 1, 10, 50]) {
    const publish = buildEventBusPublisher(subscriberCount);
    const label = subscriberCount === 1 ? "subscriber" : "subscribers";
    eventBusResults.push(
      await runAsyncBenchmark(`event bus: publish() with ${subscriberCount} ${label}`, publish),
    );
  }

  process.stdout.write("\n" + "=".repeat(78) + "\n");
  process.stdout.write("Capability broker overhead\n");
  process.stdout.write("=".repeat(78) + "\n\n");
  process.stdout.write(formatTable(brokerResults) + "\n");

  process.stdout.write("\n" + "=".repeat(78) + "\n");
  process.stdout.write("Event bus dispatch overhead\n");
  process.stdout.write("=".repeat(78) + "\n\n");
  process.stdout.write(formatTable(eventBusResults) + "\n");

  const raw = brokerResults[0] as BenchResult;
  const handleInvoke = brokerResults[2] as BenchResult;
  const obtainHotPath = brokerResults[1] as BenchResult;
  process.stdout.write(
    `\n-> Pre-obtained handle invocation overhead vs raw call: ` +
      `${(handleInvoke.avgLatencyUs - raw.avgLatencyUs).toFixed(3)} µs/call\n`,
  );
  process.stdout.write(
    `-> obtain() hot-path overhead vs pre-obtained handle: ` +
      `${(obtainHotPath.avgLatencyUs - handleInvoke.avgLatencyUs).toFixed(3)} µs/call\n`,
  );
  const zeroSub = eventBusResults[0] as BenchResult;
  const fiftySub = eventBusResults[3] as BenchResult;
  process.stdout.write(
    `-> event bus per-subscriber marginal cost (50 subs vs 0): ` +
      `${((fiftySub.avgLatencyUs - zeroSub.avgLatencyUs) / 50).toFixed(3)} µs/subscriber\n`,
  );

  process.stdout.write(
    "\nPaste both tables above into docs/performance-baseline.md §6 " +
      "(Kernel plugin-dispatch overhead).\n",
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("kernel-dispatch-benchmark failed:", error);
    process.exit(1);
  });
