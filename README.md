# Love Mochi Backend

Express 5 and strict TypeScript foundation for the Love Mochi API. Bun is used for local development and Node 24 runs the production build.

## Local setup

1. Install [Bun](https://bun.sh/).
2. Run `bun install`.
3. Copy `.env.example` to `.env` and fill in the Supabase values. Never expose or commit the service-role key; it is server-only.
4. Run `bun run dev`.
5. Open `http://localhost:3000/health`.

## Care notifications

When a co-parent logs a care action, the API sends a Web Push to the other
co-parent's subscribed browsers right after the activity is saved. It is
instant and best effort: there is no worker, queue, Redis, or retry, and a
failed send is dropped. Each activity's `notification_outbox` row is claimed
once (`claim_care_notification`), so idempotent replays never notify twice.
Subscriptions that the push service reports as gone (404/410) are disabled.

Generate a VAPID key pair once with `bunx web-push generate-vapid-keys --json`,
then set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and a `VAPID_SUBJECT` such as
`mailto:notifications@example.com`. The private key is server-only; only the
public key may be copied into the PWA configuration. Set
`CORS_ALLOWED_ORIGINS` to a comma-separated list of exact app origins (the
example includes Vite's `5173`); wildcard origins are rejected.

For a local end-to-end check, run `bun run dev`, register a browser
subscription through `POST /api/devices/web-push-subscriptions`, create a care
activity as the other pair member, and confirm a single notification opens the
relative `/timeline?activityId=...` target.

Useful checks are `bun run typecheck`, `bun run lint`, `bun test`, and `bun run build`. Start the compiled Node build with `bun run start`.

## Railway

Deploy one service: `node dist/server.js` with health check `/health`. It must
define `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, and `CORS_ALLOWED_ORIGINS` (the exact PWA
production origin). `PORT`, `NODE_ENV`, and `LOG_LEVEL` are optional and have
safe defaults. The service holds no background work, so Railway serverless
sleep can be enabled.

Apply migrations in timestamp order before starting the service.
