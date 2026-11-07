# LangRelay for EmDash

Translate your [EmDash](https://emdashcms.com) site with
[LangRelay](https://langrelay.com). The plugin tells LangRelay about every
change to a live page the moment it happens, so your translations follow
your content.

## What it does

- **Every change reaches LangRelay at once.** Publishing, updating a live
  page, changing its slug, unpublishing, trashing and deleting are each
  sent to your LangRelay Site's change hook. A change LangRelay cannot take
  right then waits, and is sent again every five minutes (a task the plugin
  schedules when you connect).
- **It shows whether it is connected**, and links to your Site in
  LangRelay.

## What it does not do

- **It adds no language switcher, no hreflang tags and no translated
  pages.** Those come from LangRelay on your own domain (Proxy delivery):
  you point your domain at LangRelay, and LangRelay serves each translated
  page with its switcher and hreflang. So a marketplace install of this
  plugin never changes your pages.
- **Script embed.** If your Site uses LangRelay's Script embed instead of a
  domain, paste its snippet into your theme. EmDash never lets a
  marketplace plugin add scripts to your pages. Only a copy installed with
  npm, as `@langrelay/emdash-plugin/trusted`, can add the snippet for you
  (below).

## Install

**From the marketplace.** Install "LangRelay" from your site's admin. EmDash
asks you to allow:

- reading your content's status and public addresses (`content:read`);
- reading which collections have public pages (`schema:read`);
- sending requests to `api.langrelay.com` (`network:request`).

The plugin asks for nothing else.

**With npm (trusted, for Script embed).**

```js
// astro.config.mjs
import langrelay from "@langrelay/emdash-plugin/trusted";

emdash({ plugins: [langrelay] });
```

This copy runs in your site's own process and may also add the Script
embed tag to every page. Use it only when your Site is on Script embed.

## Connect

1. In LangRelay, open your Site, then **Connection**, then **Change hook**.
   Create the hook and copy its URL. LangRelay shows it once.
2. In EmDash, open **LangRelay** in the admin. Paste the URL (or just the
   `lrh_…` token) and choose **Connect**.
3. The plugin sends a test report that starts nothing. When LangRelay
   accepts it, the page says **Connected to LangRelay** and links straight
   to your Site's change hook.

Your site needs EmDash's encryption key (`EMDASH_ENCRYPTION_KEY`; `npx
emdash secrets generate` makes one), because the plugin keeps the hook as
an encrypted setting. Without it the page says so, and keeps nothing. It
also needs its URL set in EmDash's settings, which every public address is
built from.

If LangRelay ignores some addresses, the page says so. That happens when
your EmDash site's URL is not the address your LangRelay Site was created
for.

## How it works

| EmDash event | Sent to the change hook |
| --- | --- |
| publish, restore, or a save that changes a live page | `{"urls": [its URL]}` |
| a slug change | `{"urls": [], "removed": [{"url": old, "movedTo": new}]}` |
| unpublish, trash, delete | `{"urls": [], "removed": [{"url": its URL}]}` |
| a draft save, scheduling | nothing (a scheduled publish is reported when it runs) |

- **URLs.** The plugin keeps each published item's URL (EmDash gives none
  once an item is unpublished). After you connect, it records the URLs of
  pages published earlier, 100 a run.
- **The queue.** At most 500 changes wait. Past that, the next send asks
  LangRelay to read the whole site instead.
- **Locales.** Items in another locale than your site's are never sent:
  LangRelay translates your source pages.

The wire is LangRelay's Change hook contract v1. A copy of its fixtures,
the same requests and answers LangRelay's API is tested against, is
vendored under `contract/hooks/v1/`, and the plugin's tests run against
it.

## Develop

Node 24 and pnpm 10.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm validate        # the manifest
pnpm build
pnpm check:manifest  # the trust contract: capabilities and hosts
pnpm check:contract  # the vendored Change hook contract
pnpm check:public    # no internal reference in any public file
pnpm test            # through EmDash's own sandbox runner (workerd)
```

CI runs all of them on every pull request.

**Against another LangRelay API.** Never point a test site at
production LangRelay. To try the plugin against a non-production
LangRelay API, create a change hook there and give your test site's
config that API's host. EmDash refuses every host the descriptor does
not name:

```js
import langrelay from "@langrelay/emdash-plugin";

emdash({
  plugins: [{ ...langrelay, allowedHosts: ["api.example.test"] }],
});
```

**Against a local LangRelay.** EmDash refuses every plugin request to a
private address or a `localhost` name: its SSRF guard resolves names
through Cloudflare's DNS over HTTPS. So a site cannot reach an API on your
own machine through the plugin's own network access. To run the plugin
against a local API, wrap its built entry in a throwaway site and give it a
`ctx.http` that reaches only that API; everything else stays this build.

**When the Change hook contract changes**, re-vendor it from LangRelay's
source of the fixtures, then check the copy against that source:

```sh
cp -R <source>/hooks/v1 contract/hooks/
LANGRELAY_CONTRACT_PATH=<source>/hooks/v1 pnpm check:contract
```

`pnpm check:public` fails on any reference that only makes sense inside
LangRelay (a ticket number, an internal host, another repository's
paths): everything here is public, so a comment says what the code
guarantees and why.

## Versions

Every pull request that changes what ships adds a changeset
(`pnpm changeset`). Merging to `main` opens a "Version packages" pull
request, and merging that bumps `package.json`. Bump:

- **major** when the manifest asks for more (a capability, a host,
  storage): installed sites consented to the old trust contract;
- **minor** for a new hook or route;
- **patch** for a fix.

## Publishing

Publishing goes from LangRelay's Atmosphere account to the EmDash registry.
Nothing in CI publishes.

1. **The publisher is pinned** to LangRelay's Atmosphere account,
   `@langrelay.com` (`did:plc:dqfzcnruxn4gqgeu5fgeclec`, in
   `emdash-plugin.jsonc`). Log in with that account
   (`emdash-plugin login langrelay.com`): the registry refuses a release whose
   session is another account (`MANIFEST_PUBLISHER_MISMATCH`).
2. **Check the bundle.** Run `pnpm install`, then `pnpm build`,
   `pnpm check:manifest`, `pnpm check:contract` and `pnpm bundle`.
   `bundle` validates the size caps, that there are no Node built-ins, and
   the capabilities and hosts. It prints the tarball's SHA-256. List the
   tarball with `tar tzf dist/langrelay-<version>.tar.gz`: `manifest.json`,
   `backend.js`, `README.md`.
3. **Log in.** Run `pnpm run login -- <handle>`, using the account's handle
   (for example `langrelay.bsky.social`). It signs in in the browser;
   EmDash never sees the password. `pnpm exec emdash-plugin whoami` shows
   the session.
4. **Publish.** Run `pnpm run publish`. It rebuilds and validates the
   bundle, checks the publisher pin and the session's blob scopes, uploads
   the tarball to the account's PDS, and **verifies each returned blob's
   checksum (CID) against the bytes it uploaded**. Then it writes the
   immutable release record. A version can be published once, so bump it
   first (above).
5. **Permissions.** Sites see the manifest's declared access on install:
   content read, schema read, and network to `api.langrelay.com`. A later
   release that asks for more must be a major version. Installed sites
   then consent again.
6. **Provenance.** The plugin is published straight from the CLI, so its
   package profile allows releases without provenance. For verifiable
   provenance, run `pnpm run release:setup` once. It writes a GitHub
   Actions workflow that builds the bundle, attests it with GitHub build
   provenance and publishes through EmDash's release service, which checks
   the checksum and the provenance against the same bytes. Connect it to
   `release.yml`'s Changesets job as EmDash's "Automated Releases" page
   says. With "require provenance" on, publish only through that workflow.
7. **Watch the listing.** `publish` prints
   `emdash-plugin info <handle> langrelay --version <version> --watch`.
   Run it until the registry's checks pass. The plugin is then listed on
   plugins.emdashcms.com.

**npm** is separate. The trusted install needs the package on npm: remove
`"private": true` from `package.json` and run `npm publish --access public`.
That is a decision of its own. Until then, a site can install the package
from this repository.

## License

MIT. Report security issues to security@langrelay.com.
