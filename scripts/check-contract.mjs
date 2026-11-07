// The Change hook contract the plugin speaks: a vendored copy of LangRelay's
// own fixtures, pinned by their SHA-256 manifest, so the plugin is tested
// against the same requests and answers the API is. Fails when a vendored
// file no longer matches the manifest, or a file is missing or extra. With
// LANGRELAY_CONTRACT_PATH set to the source's `hooks/v1` directory, it also
// fails when the source differs: then re-vendor with
// `cp -R "$LANGRELAY_CONTRACT_PATH" contract/hooks/`.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const VENDORED = new URL("../contract/hooks/v1/", import.meta.url);
const failures = [];

const manifest = JSON.parse(
  await readFile(new URL("manifest.json", VENDORED), "utf8"),
);
const files = (await readdir(VENDORED))
  .filter((file) => file !== "manifest.json")
  .sort();
const listed = Object.keys(manifest.fixtures).sort();
if (JSON.stringify(files) !== JSON.stringify(listed)) {
  failures.push(
    `contract/hooks/v1 holds ${files.join(", ")}; its manifest lists ${listed.join(", ")}`,
  );
}
const checked = await Promise.all(
  Object.entries(manifest.fixtures).map(async ([file, expected]) => ({
    actual: createHash("sha256")
      .update(await readFile(new URL(file, VENDORED)))
      .digest("hex"),
    expected,
    file,
  })),
);
for (const { actual, expected, file } of checked) {
  if (actual !== expected) {
    failures.push(
      `${file} has drifted from manifest.json: re-vendor it, never edit it`,
    );
  }
}

const source = process.env.LANGRELAY_CONTRACT_PATH;
if (source) {
  const theirs = await readFile(join(source, "manifest.json"), "utf8");
  const ours = await readFile(new URL("manifest.json", VENDORED), "utf8");
  if (theirs !== ours) {
    failures.push(`${source} holds another Change hook contract: re-vendor it`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `Change hook contract v1: ${listed.length} fixtures match${source ? " the source's" : " the manifest"}.`,
);
