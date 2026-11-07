import type { PageFragmentContribution } from "emdash";

/**
 * Script delivery's tag, for a trusted npm install only: EmDash lets only
 * a plugin running in the site's own process add scripts to pages. The
 * person pastes the Script embed snippet from the Site's Connection page;
 * the plugin adds the same tag to every page through `page:fragments`. A
 * marketplace install never runs that hook: there the snippet goes into
 * the theme by hand.
 */

export const SNIPPET_SETTING = "snippet";

const ATTRIBUTE = /([a-z-]+)="([^"]*)"/gu;
const SCRIPT = /^<script\s([^>]*)>\s*<\/script>$/u;
const SITE_KEY = /^lrk_[A-Za-z0-9_-]+$/u;
const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/u;

export interface ScriptEmbed {
  readonly integrity?: string;
  readonly siteKey: string;
  readonly src: string;
}

/** The Dashboard's snippet (pinned or alias), read; `null` for anything
 * else, so a pasted typo never reaches a page. */
export function parseSnippet(input: string): ScriptEmbed | null {
  const match = SCRIPT.exec(input.trim().replace(/\s+/gu, " "));
  if (match?.[1] === undefined) {
    return null;
  }
  const attributes = new Map<string, string>();
  for (const [, name, value] of match[1].matchAll(ATTRIBUTE)) {
    if (name !== undefined && value !== undefined) {
      attributes.set(name, value);
    }
  }
  const src = attributes.get("src");
  const siteKey = attributes.get("data-langrelay-site-key");
  const integrity = attributes.get("integrity");
  if (src === undefined || siteKey === undefined || !SITE_KEY.test(siteKey)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") {
    return null;
  }
  if (integrity !== undefined && !INTEGRITY.test(integrity)) {
    return null;
  }
  return {
    ...(integrity === undefined ? {} : { integrity }),
    siteKey,
    src: url.href,
  };
}

/** The tag, as the Dashboard's snippet writes it. */
export function embedFragment(embed: ScriptEmbed): PageFragmentContribution {
  return {
    attributes: {
      crossorigin: "anonymous",
      "data-langrelay-site-key": embed.siteKey,
      referrerpolicy: "no-referrer",
      ...(embed.integrity === undefined ? {} : { integrity: embed.integrity }),
    },
    defer: true,
    key: "langrelay-script-embed",
    kind: "external-script",
    placement: "head",
    src: embed.src,
  };
}
