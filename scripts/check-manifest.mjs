// The trust contract: what the marketplace manifest and the trusted
// descriptor may ask for. A change here is a deliberate one: bump the major
// version (installed sites consented to the old contract) and update this
// list in the same pull request.
import { readFile } from "node:fs/promises";

const MARKETPLACE = {
  allowedHosts: ["api.langrelay.com"],
  capabilities: ["content:read", "network:request", "schema:read"],
};
const TRUSTED_EXTRA = ["hooks.page-fragments:register"];

const failures = [];
const same = (a, b) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const built = JSON.parse(
  await readFile(new URL("../dist/manifest.json", import.meta.url), "utf8"),
);
const capabilities = built.capabilities ?? [];
const hosts = built.allowedHosts ?? [];
if (!same(capabilities, MARKETPLACE.capabilities)) {
  failures.push(
    `manifest capabilities are ${capabilities.join(", ")}; expected ${MARKETPLACE.capabilities.join(", ")}`,
  );
}
if (!same(hosts, MARKETPLACE.allowedHosts)) {
  failures.push(
    `manifest allowedHosts are ${hosts.join(", ")}; expected ${MARKETPLACE.allowedHosts.join(", ")}`,
  );
}
if (built.capabilities?.includes("network:request:unrestricted")) {
  failures.push("the plugin must never ask for unrestricted network access");
}

const { default: trusted } = await import("../trusted.mjs");
const { default: marketplace } = await import("../dist/index.mjs");
if (
  !same(trusted.capabilities, [...MARKETPLACE.capabilities, ...TRUSTED_EXTRA])
) {
  failures.push(
    `the trusted descriptor asks for ${trusted.capabilities.join(", ")}`,
  );
}
if (
  !same(marketplace.capabilities, MARKETPLACE.capabilities) ||
  !same(trusted.allowedHosts, MARKETPLACE.allowedHosts)
) {
  failures.push("the descriptors disagree with the manifest");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `Trust contract holds: ${MARKETPLACE.capabilities.join(", ")} to ${MARKETPLACE.allowedHosts.join(", ")}; trusted adds ${TRUSTED_EXTRA.join(", ")}.`,
);
