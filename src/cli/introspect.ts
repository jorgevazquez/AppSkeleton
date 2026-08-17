/**
 * CLI wrapper around the kernel introspection API (feature #13, step 2:
 * "write a small CLI script ... that prints this report in human-readable
 * form"). Boots a real kernel exactly like `src/server/index.ts`'s own
 * `main()` — same `bootstrapKernel()`, same fatal-vs-isolated error handling
 * — but instead of starting the HTTP server, prints `kernel.introspect()`'s
 * report (formatted by introspect.ts's `formatIntrospectionReport()`) to
 * stdout and exits.
 *
 * Run via `npm run introspect` (see package.json), or directly with
 * `npx tsx src/cli/introspect.ts`.
 */
import { formatIntrospectionReport } from "../core/introspect.js";
import { bootstrapKernel, formatFatalStartupError } from "../server/index.js";

async function main(): Promise<void> {
  const kernel = await bootstrapKernel();
  console.log(formatIntrospectionReport(kernel.introspect()));
}

main().catch((cause: unknown) => {
  // Same "single line, no stack trace" contract as server/index.ts's own
  // fatal startup path — see that module's docs.
  console.error(`Fatal startup error: ${formatFatalStartupError(cause)}`);
  process.exit(1);
});
