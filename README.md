# lobby-platform

AI-first building management: residents report problems over WhatsApp, a Claude
agent opens tickets, vendors and the building committee act through WhatsApp
buttons, and staff run everything from a Hebrew admin UI. Multi-tenant from day
one (`company_id` on every row, Postgres RLS).

**Status: pilot, day 1 of 7.** Done: schema v0 with RLS, seed, i18n layer,
WhatsApp webhook (verify, signature check, idempotent, echo reply), template
drafts. Not built yet: admin UI and auth, imports, the agent, dispatch,
approvals, billing.

## Stack

Next.js (App Router, TypeScript) on Vercel · Supabase (Postgres + RLS, Auth,
Storage) · WhatsApp Cloud API · Claude API · plain SQL migrations · Zod · Vitest.

## Setup

Requires Node 22+, pnpm, Docker (for local Supabase).

```bash
pnpm install
pnpm dlx supabase start      # local Postgres/Auth/Storage; prints URL and keys
pnpm dlx supabase db reset   # applies supabase/migrations, then supabase/seed.sql
cp .env.example .env.local   # fill in from the `supabase start` output
pnpm dev
```

Checks: `pnpm test`, `pnpm typecheck`, `pnpm lint`.

Tenant-isolation test (run against the local database after `db reset`):

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/rls_isolation.sql
```

## Environment variables

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key for the admin UI (from day 2) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only; bypasses RLS. Used by the webhook and cron |
| `WA_VERIFY_TOKEN` | Random string, also entered in Meta's webhook configuration |
| `WA_APP_SECRET` | Meta app secret; verifies `X-Hub-Signature-256` |
| `WA_ACCESS_TOKEN` | Cloud API token. Unset = outbound messages are dry-run |
| `WA_GRAPH_VERSION` | Graph API version (default `v23.0`) |
| `WA_ALLOWLIST` | Comma-separated E.164 numbers allowed to receive messages |
| `WA_LIVE` | Only the exact value `true` lifts the allowlist |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude agent (from day 3) |

## WhatsApp webhook

`/api/webhooks/whatsapp`

- `GET` answers Meta's verification handshake using `WA_VERIFY_TOKEN`.
- `POST` verifies the signature, routes by `metadata.phone_number_id` to
  `companies.wa_phone_number_id`, stores each message once (unique
  `wa_message_id`) and, for now, echoes the text back in the sender's language.

To test against Meta in dev: expose `pnpm dev` with a tunnel, set the callback
URL and verify token in the Meta app, subscribe to the `messages` field, set
`companies.wa_phone_number_id` to your test number's id (the seed uses a
placeholder), and put your own phone in `WA_ALLOWLIST`.

Outbound safety: every send goes through `src/lib/whatsapp/client.ts`, which
refuses numbers outside `WA_ALLOWLIST` unless `WA_LIVE=true`. Every attempt is
logged in `messages` with status `sent`, `blocked`, `dry_run` or `failed`.

## i18n

- Catalogs live in `messages/<locale>.json`; `he` is the default and defines the
  key set. Supported locales are listed in `src/i18n/config.ts`.
- UI: `useTranslations()` / `getTranslations()` from `next-intl`. `<html>` gets
  `lang` and `dir` from the locale.
- WhatsApp and other server-side text: `getTranslator(person.lang)` from
  `src/i18n/translator.ts`. Unknown languages fall back to Hebrew.
- No user-facing strings in code. `tests/i18n.test.ts` fails on any Hebrew
  character under `src/` and on catalogs whose keys differ.
- WhatsApp templates are per language and approved separately by Meta; see
  `templates/README.md`.

## Database

Plain SQL migrations in `supabase/migrations`. Conventions: money is integer
agorot (`*_agorot`), timestamps are `timestamptz`, display in Asia/Jerusalem.
Staff are Supabase Auth users mapped to companies in `company_members`; RLS
policies allow a row only when its `company_id` is one of the caller's
companies. Server code using the service role must filter by `company_id` itself.

## Go-live runbook

Written on day 7. Known prerequisites so far: Meta business verification, a
production WhatsApp number, approved templates (`templates/he.json`), a
permanent system-user token, and `WA_LIVE=true` set only in Vercel production.
