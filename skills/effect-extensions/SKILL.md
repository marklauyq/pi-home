---
name: effect-extensions
description: Build or modify pi extensions in ~/.pi/agent that need structured async — background jobs, child processes, streaming event pipelines, cancellation, timeouts. Documents the installed Effect v4-beta dependency, the reference extensions (subagent, background-terminals), the ManagedRuntime + runTool pattern, when NOT to use Effect, and v3→v4 API traps. Use before writing new async-heavy extension code in this repo.
---

# Effect v4 for pi Extensions

## What is installed, and where

- `effect@^4.0.0-beta.99` (Effect Inc.'s functional TypeScript library) is a dependency of the **agent home itself**: `~/.pi/agent/package.json` (git-tracked). `~/.pi/agent/node_modules/` is machine-local (gitignored).
- **Fresh machine / other checkout:** `cd ~/.pi/agent && npm install` before any extension importing `effect` will load.
- pi's extension loader (jiti) only aliases `@earendil-works/pi-*` and `typebox` into extensions. **Any other import (`effect`, third-party SDKs) must resolve via normal node walk-up from the extension file** — i.e. it must live in `~/.pi/agent/node_modules`. Add new dependencies to the root `package.json` (tracked) and commit the updated lockfile.

## Reference implementations in this repo

- `extensions/subagent/` — subagents as **in-process `AgentSession`s** from pi's SDK (`createAgentSession`): normalized event streams (`Effect.Queue`/`Stream`) pumped into mutable snapshots, scoped fibers per run, interactive `/subagents` takeover (steer/abort), deferred result delivery as follow-up messages.
- `extensions/background-terminals/` — background shell process trees with the same architecture (`bg_start`/`bg_status`/`bg_list`/`bg_kill` + `/ps` UI).

Both share the same skeleton: `src/runtime.ts` (Layer composition + `ManagedRuntime` + `runTool`), `src/manager.ts` (the Effect core service), `index.ts` (the plain-async boundary: pi tools/commands/UI handlers).

## The one rule: Effect is for the async core, not the whole extension

pi's public surface is plain callbacks: `export default function (pi: ExtensionAPI)`, `pi.registerTool({ async execute() })`, `pi.registerCommand`, `pi.on(...)`, renderers. Effect lives *inside* those.

- **Use Effect** when you get something real from it: typed errors, cancellation via the tool `AbortSignal`, timeouts/retries, or a resource whose lifetime outlives one tool call (child session, process, subscription).
- **Stay plain TS** for pure TUI popups, renderers, event bookkeeping, string formatting. Don't invent an Effect layer to have one.

## The skeleton (copy from `extensions/background-terminals/src/runtime.ts`)

```ts
// src/runtime.ts — one managed runtime per extension
import { Cause, Exit, Layer, ManagedRuntime, type Effect } from "effect";

const AppLayer = MyServiceLive; // compose services with Layer.provide / mergeAll

export function createRuntime() {
  return ManagedRuntime.make(AppLayer);
}
export type ExtRuntime = ReturnType<typeof createRuntime>;

/** Run an effect from an async pi tool handler. */
export async function runTool<A, E>(
  runtime: ExtRuntime,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal; interruptMessage?: string } = {},
) {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error(options.interruptMessage ?? "Operation was aborted.");
  }
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
```

Wiring in `index.ts`:

```ts
export default function (pi: ExtensionAPI) {
  let runtime: ExtRuntime | undefined;
  const getRuntime = () => (runtime ??= createRuntime());

  pi.registerTool({
    name: "my_tool",
    parameters: Type.Object({ /* typebox */ }),
    async execute(_id, params, signal) {
      const value = await runTool(getRuntime(), myEffect(params), {
        signal,                    // tool abort (Ctrl+C) interrupts the fiber
        interruptMessage: "Cancelled.",
      });
      return { content: [{ type: "text", text: String(value) }] };
    },
  });

  pi.on("session_shutdown", async () => {
    const closing = runtime;
    runtime = undefined;
    await closing?.dispose();      // runs ALL finalizers: kills scoped resources
  });
}
```

Key facts:

- `runPromiseExit(effect, { signal })` — the tool's `AbortSignal` interrupts the fiber; scoped resources (child processes, sessions) tear down deterministically.
- `runtime.runFork(effect)` — fire-and-forget background work (polling loops); interrupted by `dispose()`.
- Put cleanup in **Effect finalizers** (`Effect.addFinalizer` / scoped services), never in ad-hoc `session_shutdown` code.
- No services at all? `Effect.runPromiseExit(effect, { signal })` works standalone — skip `ManagedRuntime` until you have a `Layer` to share.

## Services, layers, typed errors (house style)

```ts
import { Context, Data, Effect, Layer } from "effect";

export class SpawnError extends Data.TaggedError("SpawnError")<{ readonly message: string }> {}

export interface MyServiceShape {
  readonly doThing: Effect.Effect<Result, SpawnError>;
}
export class MyService extends Context.Service<MyService, MyServiceShape>()("ext/MyService") {}

export const MyServiceLive: Layer.Layer<MyService, never> = Layer.effect(
  MyService,
  Effect.gen(function* () {
    /* build with scoped resources; finalizers registered here */
    return MyService.of({ doThing: /* ... */ });
  }),
);
```

## v4 beta traps (do not re-derive; grep `node_modules/effect/dist/*.d.ts` when unsure)

- `Context.Service` — `Effect.Service` is **gone**; `Context.Tag` is gone too.
- `Effect.fork` → `Effect.forkChild`; `Effect.forkDaemon` → `Effect.forkDetach`.
- `Effect.async` → `Effect.callback`; `Effect.catchAll` → `Effect.catch`.
- `Effect.zipRight`/`zipLeft` → `Effect.andThen`/`Effect.tap`; `Effect.either` → `Effect.result`.
- `Either` module → `Result` (`Result.succeed`/`Result.fail`).
- `@effect/platform` is **merged into core `effect`** (`FileSystem`, `Path` top-level); child processes live in `effect/unstable/process` (`ChildProcess`, `ChildProcessSpawner` — the class is imported from the `.../ChildProcessSpawner` submodule).
- **`unstable/*` modules can break between betas** — pin exact versions, don't float.
- Early v4 betas renamed `Context` → `ServiceMap`; that was **reverted**. Ignore blog posts/AI answers saying `ServiceMap`.
- v4 source lives in the `Effect-TS/effect-smol` repo; migration guide: `effect-smol/MIGRATION.md` + `migration/v3-to-v4.md`.

## Verify (this repo's rules still apply)

1. `inspect_extension` on the changed file(s) — confirms it loads and registers without errors.
2. Live smoke test per the `pi-tmux-verify` skill (headless run + tmux session, inspect output).
3. For async teardown in particular: trigger the shutdown path (spawn something, then `/new` or quit) and confirm no leaked processes/sessions.
4. Checkpoint (`git add -A`, commit, push) per the global AGENTS.md; remember `npm install` is needed on other machines when `package.json` gained a dependency.
