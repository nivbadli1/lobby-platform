# lobby-platform

AI-first building management: residents report problems over WhatsApp, a Claude
agent opens tickets, vendors and the building committee act through WhatsApp
buttons, and staff run everything from a Hebrew admin UI. Multi-tenant from day
one (`company_id` on every row, Postgres RLS).

**Status: pilot, day 2 of 7.** Done: frozen schema with RLS, seed, i18n layer,
WhatsApp webhook (verify, signature check, at-least-once processing, echo
reply), template drafts, admin sign-in, building setup, CSV/Excel import of
units, people and vendors. Not built yet: the agent, ticket board, dispatch,
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
node --env-file=.env.local scripts/create-admin.mjs you@example.com 'a-long-password' "Demo Management Ltd"
pnpm dev
```

The `create-admin` script creates a staff login and links it to a company
(created if the name is new). "Demo Management Ltd" is the seeded company, so
that login sees the demo building. Sign in at `/login`.

Checks: `pnpm test`, `pnpm typecheck`, `pnpm lint`.

Database tests (run against the local database after `db reset`):

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/rls_isolation.sql
```

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/functions.sql
```

## Environment variables

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon (or publishable) key; the admin UI signs in with it |
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

Processing is at-least-once. A stored message is claimed
(`claim_inbound_message`), handled, then marked `processed_at`. If handling
fails, including a failed reply send, the claim is released and the route
answers 500 so Meta redelivers; after 5 attempts the message is left
unprocessed and logged. A crashed invocation's claim expires after 2 minutes.

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

## Onboarding a building

1. `/buildings` → new building: name, slug, fee per sqm, committee threshold and policy, bank details.
2. On the building page, import files in this order: units, people, vendors.
   Each file is checked first and problems are listed row by row; nothing is
   written until the file is clean, and an import is all-or-nothing.
   Importing the same file again updates rows instead of duplicating them.

Accepted files: `.csv` (comma, semicolon or tab; UTF-8, UTF-16 or Windows-1255)
and `.xlsx` (first sheet). Legacy `.xls` is not supported; save as xlsx.
Headers may be Hebrew or English; the accepted names and values are listed in
`config/import-aliases.json`.

| File | Required columns | Optional |
|---|---|---|
| Units | floor, number, sqm | |
| People | full_name, phone, unit, role (owner / tenant / committee) | payer, updates, lang |
| Vendors | name, phone, categories (comma-separated) | default |

People: one row per role a person has in a unit (an owner who is also on the
committee gets two rows). A unit has one payer; a file's payer replaces the
current one. Vendors: `default` makes the vendor the building's default for the
row's categories.

## Database

Plain SQL migrations in `supabase/migrations`. Conventions: money is integer
agorot (`*_agorot`), timestamps are `timestamptz`, display in Asia/Jerusalem.
Staff are Supabase Auth users mapped to companies in `company_members`; RLS
policies allow a row only when its `company_id` is one of the caller's
companies. Server code using the service role must filter by `company_id` itself.

**The schema is frozen** as of `20261117000000_schema_v1_freeze.sql`.

### Hosted Supabase settings

`supabase/config.toml` only affects local development. On the hosted project set
these by hand:

- Authentication → Sign In / Providers: turn off "Allow new users to sign up". Staff are created with `scripts/create-admin.mjs`.
- Authentication → URL Configuration: Site URL = the production URL; add the Vercel preview pattern to Redirect URLs if previews need sign-in.
- Authentication: minimum password length 10 (matches local).
- The private `ticket-media` storage bucket and its read policy are created by the migration; nothing to do in the dashboard.
- Apply migrations with `supabase link` then `supabase db push`. Do not run the seed on the hosted project.

## Go-live runbook

Written on day 7. Known prerequisites so far: Meta business verification, a
production WhatsApp number, approved templates (`templates/he.json`), a
permanent system-user token, and `WA_LIVE=true` set only in Vercel production.
