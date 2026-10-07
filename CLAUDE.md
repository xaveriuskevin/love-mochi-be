# LOVE MOCHI — Backend

You work in the **LOVE MOCHI backend repo**. You do NOT touch `../love-mochi-app/` or `../love-mochi-orchestrator/` source, but you DO read task specs from `../love-mochi-orchestrator/tasks/inbox-be/` and contracts from `../love-mochi-orchestrator/tasks/contracts/`.

**The product**: two co-parents share **one** Mochi. Either person feeds/walks/plays; the other sees it.

---

## Skills

| Skill | When |
|---|---|
| `senior-backend` | **Every task.** Always invoke. |

Every spec stamps `skills: [senior-backend]` plus a "Skills to invoke" body section. Invoke it before writing code and say so out loud.

---

## Stack (locked)

| Layer | Choice |
|---|---|
| Package manager | **Bun** (dev) / Node 20 (prod via Docker) |
| Framework | **Express 5** + TypeScript strict |
| DB | **Supabase** (managed postgres) |
| Validation | **Zod** |
| Logging | **Pino** (+ pino-pretty in dev only) |
| Jobs | **None** — no worker, queue, or Redis. The API is a single service that can sleep |
| Realtime | **Supabase Realtime** (postgres_changes) — no custom WS server |
| Push | **Web Push** (VAPID, `web-push`) sent instantly by the API after a care action, best effort (no retries) — web app + PWA only, no Expo |
| Deploy | Railway |

---

## The two rules that define this backend

### 1. The clock is authoritative and **lazily computed**

Hunger / energy / mood decay over time. There is **no cron ticking stats** and **no `current_hunger` column**.

The DB stores **event timestamps** — `last_fed_at`, `last_walked_at`, `last_played_at`. Current stats are a **pure function of (timestamps, `now()`)**, computed in a Postgres function on read.

- Two devices reading a second apart compute the **same** value. Decay needs no sync — only *actions* do.
- A stat is never written directly. You write "fed at T"; hunger falls out of it.
- Decay rates live in one place (a config table or a single SQL constant), never scattered across queries.

Anything that tempts you to persist a computed stat is a bug. Push back on the spec.

### 2. Everything is pair-scoped

Two co-parents, one pet. **Never trust a client-sent `pair_id`.** Resolve the caller's pair from their authenticated user id server-side, every time, on every route. A plain `user_id` filter is almost always the wrong check here — it should be a pair-membership check.

When one co-parent acts, the other's device must find out. State the mechanism per endpoint: Supabase Realtime on the changed row, or push, or next-refetch.

---

## Hard rules

1. **MVC layout.** Each feature is `src/api/<feature>/` with three files: `<feature>Router.ts` (routes), `<feature>Controller.ts` (validation + auth + response shape), `<feature>Service.ts` (business logic).
2. **Queries live in `src/queries/<domain>.ts`**, one file per domain, calling Supabase RPC functions.
3. **Heavy logic goes in Postgres, not Node.** If a flow implies 3+ sequential DB calls, it should be an RPC. Say so rather than looping in Node.
4. **Register routes in `src/server.ts`.** Path alias `@/` → `src/`.
5. **Auth**: `requireAuth` middleware from `@/middleware/auth`. Errors: `ApiError` from `@/utils/errors`.
6. **Env vars** go in the `env.ts` zod schema AND `.env.example` AND the Railway dashboard. All three, always.
7. **Response shapes mirror the contract verbatim.** Don't invent fields.
8. **Every new route gets at least one integration test.**

## DB workflow (CRITICAL — you don't run DB commands)

1. You provide SQL, or write a migration file.
2. **The operator applies it** in Supabase (or `supabase db push`).
3. You update `src/queries/<domain>.ts` to call the new function.
4. You call the query from the service.

When a spec requires DB changes, say so explicitly and **stop for operator action** before continuing. Migrations must be idempotent (`create or replace function`, `add column if not exists`).

---

## Bootstrap specs (`bootstrap: true`)

A spec with `bootstrap: true` in frontmatter runs against an **empty repo**. For those specs only:

- **Skip the pre-flight typecheck.** There's nothing to typecheck yet — that's the point.
- Scaffold the project per the locked stack table above, then make `bun run typecheck` pass before you finish.
- Every later spec assumes a clean typecheck, so leaving the repo green is the acceptance criterion.

Normal specs keep the pre-flight check. If a non-bootstrap spec hits an empty repo, STOP — the bootstrap spec hasn't run yet.

---

## Workflow — "next task"

1. `ls ../love-mochi-orchestrator/tasks/inbox-be/ | sort` — oldest-first.
2. Pick the first spec with `status: ready` and `depends_on` satisfied.
3. Read the spec and its contract fully.
4. Invoke `senior-backend`. Say so out loud.
5. Delegate to the `task-executor` subagent.
6. After execution: append `## Done`, then `mv` the spec to `../love-mochi-orchestrator/tasks/done/`.
7. Report back: spec id, files changed, any SQL the operator must apply.

If no ready tasks, say so. Don't invent work.

---

## Commands

```bash
bun install
bun add <pkg>@latest
bun run dev
bun run build
bun run typecheck
bun test
```

---

## When you stop and ask the orchestrator

Append `## Question for orchestrator` and stop if:
- The contract is missing detail the spec depends on.
- The spec asks you to persist a computed stat (violates the lazy-clock rule).
- The spec's auth model isn't pair-scoped and should be.
- The spec contradicts the contract or another done spec.
