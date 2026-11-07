// Everything in this repository, and everything the build emits, is public.
// This check fails when a file carries a reference that only makes sense
// inside LangRelay: a ticket or decision-record number, a path or name from
// another of LangRelay's repositories, a person, an internal process or
// host. Say what the code guarantees and why instead.
//
// It scans every tracked file (`git ls-files`, so new files are covered once
// added) and, when present, the build output in `dist/` (the tarball's
// `backend.js`, `manifest.json` and README come from those files and this
// README). People are matched by the names in this repository's own commit
// authors, so the check names nobody itself.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// Any host under a LangRelay domain, unless the public knows it.
const LANGRELAY_HOST =
  /\b(?:[a-z0-9-]+\.)*langrelay\.[a-z]{2,}(?:\.[a-z]{2,})*(?![\w-])/giu;
const PUBLIC_HOSTS = new Set([
  "langrelay.com",
  "www.langrelay.com",
  "api.langrelay.com",
  "app.langrelay.com",
]);

const RULES = [
  ["a ticket id", /\b[A-Z]{2,5}-\d+\b/u],
  ["a decision-record number", /\bADR[\s-]?\d/iu],
  ["a decision or section number", /\b(?:decision|amendment)\s+\d|§\s?\d/iu],
  ["a pull request or issue number", /(?<![\w&/])#\d{2,}\b/u],
  ["another LangRelay repository", /\blangrelay\/(?!emdash\b)[a-z]/iu],
  ["a path in another repository", /\b(?:apps|packages)\/[a-z]/u],
  ["a decision record", /\bdocs\/adr\b/iu],
  [
    "an internal role or tool",
    /\b(?:Linear|Pullfrog|coordinator|builders?)\b/u,
  ],
  ["an end-to-end scenario", /\bScenario\s+\d+|\bE2E_[A-Z_]+/u],
  ["an internal host", /\.localhost\b|\bstaging\b/iu],
  ["a decision date", /\b20\d\d-[01]\d-[0-3]\d\b/u],
  [
    "a LangRelay host that is not public",
    (line) =>
      [...line.matchAll(LANGRELAY_HOST)].some(
        ([host]) => !PUBLIC_HOSTS.has(host.toLowerCase()),
      ),
  ],
];

// Genuine false positives: `[path or "*", text]`, removed from a line before
// it is checked. Keep it short.
const ALLOW = [
  // An abbreviation, not a ticket.
  ["*", "SHA-256"],
  ["*", "SHA-384"],
  ["*", "SHA-512"],
  ["*", "UTF-8"],
  // A file name and a social handle, not hosts.
  ["*", "/langrelay.js"],
  ["*", "langrelay.bsky.social"],
];

const SKIP = new Set(["scripts/check-public.mjs"]);

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function people() {
  const names = new Set();
  let log = "";
  try {
    log = git("log", "--format=%an%n%cn");
  } catch {
    return [];
  }
  for (const line of log.split("\n")) {
    if (/\[bot\]|^GitHub$|^github-actions/u.test(line)) {
      continue;
    }
    for (const word of line.split(/\s+/u)) {
      if (/^[A-Z][a-z]{2,}$/u.test(word)) {
        names.add(word);
      }
    }
  }
  return [...names];
}

const names = people();
const rules = [
  ...RULES,
  ...(names.length > 0
    ? [["a person's name", new RegExp(`\\b(?:${names.join("|")})\\b`, "u")]]
    : []),
];

const files = git("ls-files", "-z")
  .split("\0")
  .filter((file) => file !== "" && !SKIP.has(file));
const dist = join(ROOT, "dist");
if (existsSync(dist)) {
  for (const file of readdirSync(dist)) {
    if (/\.(?:mjs|js|json|md|d\.mts)$/u.test(file)) {
      files.push(`dist/${file}`);
    }
  }
}

const hits = [];
for (const file of files) {
  const path = join(ROOT, file);
  // A symlink (CLAUDE.md) is checked as the file it points to.
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) {
    continue;
  }
  const lines = readFileSync(path, "utf8").split("\n");
  const allow = ALLOW.filter(([only]) => only === "*" || only === file);
  lines.forEach((text, index) => {
    const scrubbed = allow.reduce(
      (line, [, genuine]) => line.replaceAll(genuine, ""),
      text,
    );
    for (const [what, rule] of rules) {
      if (typeof rule === "function" ? rule(scrubbed) : rule.test(scrubbed)) {
        hits.push(
          `${file}:${index + 1}: ${what}: ${text.trim().slice(0, 120)}`,
        );
        return;
      }
    }
  });
}

if (hits.length > 0) {
  console.error(hits.join("\n"));
  console.error(
    `\n${hits.length} line(s) carry an internal reference. Public files say what the code does and why, not where it was decided.`,
  );
  process.exit(1);
}
console.log(`Public sources: ${files.length} files, no internal reference.`);
