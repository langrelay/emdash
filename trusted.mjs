// The descriptor for a trusted npm install: the marketplace descriptor plus
// `hooks.page-fragments:register`, so a Site on Script delivery gets its
// Script embed tag on every page. Pass it to `emdash({ plugins: [...] })`,
// never `sandboxed`: EmDash never runs `page:fragments` in the sandbox.
import descriptor from "./dist/index.mjs";

const trusted = Object.freeze({
  ...descriptor,
  capabilities: [...descriptor.capabilities, "hooks.page-fragments:register"],
});

export default trusted;
