# Changesets

Every pull request that changes what ships adds one: `pnpm changeset`.
Pick the bump the plugin's README names ("Versions"); a change to the
manifest's capabilities, hosts or storage is at least minor.
A pull request that ships nothing carries the `no-release` label instead.
