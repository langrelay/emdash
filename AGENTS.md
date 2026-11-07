# LangRelay for EmDash: agent instructions

The LangRelay plugin for EmDash. It reports every change to a live page to
the Site's Change hook, and shows whether it is connected. The README says
what it does and does not do; read it before changing what the plugin
sends, asks for or shows.

Everything in this repository is public. Comments, docs, test names and
changesets say what the code guarantees and why, in product terms: no
ticket or decision-record numbers, no other repository's names or paths,
no people, no internal hosts or process. `pnpm check:public` fails CI on
them.

## Rules

- **The plugin reports; it never delivers.** No hreflang through
  `page:metadata`, no switcher: LangRelay's delivery on the site's own
  domain owns both, so two sources never disagree. `page:fragments` adds
  only the Script embed tag, and only in a trusted npm install
  (`trusted.mjs`); EmDash never runs it in the sandbox.
- **The trust contract is fixed.** `content:read`, `schema:read` and
  `network:request` to `api.langrelay.com` in the marketplace manifest;
  `trusted.mjs` adds `hooks.page-fragments:register`.
  `scripts/check-manifest.mjs` fails CI on any other list. Changing it
  needs a major version and that script, in one pull request: installed
  sites consented to the old list.
- **The wire is vendored, never imported.** `contract/hooks/v1/` is a copy
  of LangRelay's Change hook fixtures with their SHA-256 manifest. Never
  edit it by hand: re-vendor it (README, "Develop"). The plugin imports no
  LangRelay package.
- **Every loop has a bound in code**: `DELIVERY_MAX`, `QUEUE_MAX`,
  `FLUSH_MAX_DELIVERIES`, `BACKFILL_BATCH` (`src/reports.ts`). The token
  sits in the hook's URL: never log a URL or a request.
- **Never point a test site at production LangRelay.** Use the local API
  (README, "Against a local LangRelay").
- **Tests run the plugin in EmDash's own runtime**
  (`@emdash-cms/plugin-test`'s runtime host): real content actions fire
  the hooks, and every outbound request is answered in the test. Before
  trusting a new green test, break the guard it covers and watch it go red.

## Layout

- `src/plugin.ts`: the hooks and the admin route.
- `src/reports.ts`: what is sent when, the queue, the URL records.
- `src/connection.ts`: the hook (parse, send, status) and the Dashboard link.
- `src/admin.ts`: the Block Kit page.
- `src/snippet.ts`: the Script embed tag (trusted only).
- `trusted.mjs`: the trusted descriptor.
- `scripts/`: the trust-contract, wire and public-source checks CI runs.

## Before a pull request

`pnpm lint`, `pnpm typecheck`, `pnpm validate`, `pnpm build`,
`pnpm check:manifest`, `pnpm check:contract`, `pnpm bundle`,
`pnpm check:public`, `pnpm test`, and a changeset
(`pnpm changeset`) unless it carries `no-release`.
