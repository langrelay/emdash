import type { PluginContext } from "emdash/plugin";

/**
 * The Site's Change hook: the one credential the plugin holds. LangRelay
 * shows its URL once, on the Site's Connection page; the person pastes the
 * URL or the bare token here.
 */

/** Where a bare token is sent. A pasted URL names its own origin, and
 * EmDash refuses any host the manifest's `allowedHosts` does not name, so
 * the published plugin can reach only this one. */
export const DEFAULT_API_ORIGIN = "https://api.langrelay.com";

/** `lrh_<hookId>_<secret>`: the hook id is `chk_` and lowercase letters and
 * digits, the secret 32 random bytes in unpadded base64url. */
const TOKEN = /^lrh_chk_[a-z0-9]+_[A-Za-z0-9_-]{43}$/u;
const HOOK_PATH = /^\/v1\/hooks\/(?<token>[^/]+)$/u;

/** The settings key the hook's URL is kept under, encrypted (a `secret` in
 * the manifest's `settingsSchema`). */
export const HOOK_SETTING = "hook";

export interface ChangeHook {
  readonly origin: string;
  readonly token: string;
}

export type ParsedHook =
  | { readonly hook: ChangeHook; readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "empty" | "malformed" | "not_https";
    };

/** What the person pasted, read as a hook: the whole URL, or the token. */
export function parseHook(input: string): ParsedHook {
  const value = input.trim();
  if (value.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (TOKEN.test(value)) {
    return { hook: { origin: DEFAULT_API_ORIGIN, token: value }, ok: true };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const token = HOOK_PATH.exec(url.pathname)?.groups?.token;
  if (token === undefined || !TOKEN.test(token) || url.search || url.hash) {
    return { ok: false, reason: "malformed" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "not_https" };
  }
  return { hook: { origin: url.origin, token }, ok: true };
}

export const hookUrl = (hook: ChangeHook): string =>
  `${hook.origin}/v1/hooks/${hook.token}`;

/** The hook the plugin holds, or `null` before it is connected. */
export async function readHook(ctx: PluginContext): Promise<ChangeHook | null> {
  const stored = await ctx.settings.get<string>(HOOK_SETTING);
  if (typeof stored !== "string") {
    return null;
  }
  const parsed = parseHook(stored);
  return parsed.ok ? parsed.hook : null;
}

/**
 * The Dashboard beside an API origin: the `api` label becomes `app`, so
 * `api.langrelay.com` → `app.langrelay.com`, and any other LangRelay API
 * host maps the same way. An origin with no `api` label links to
 * `app.langrelay.com`.
 */
export function dashboardOrigin(apiOrigin: string): string {
  const url = new URL(apiOrigin);
  const labels = url.hostname.split(".");
  const api = labels.indexOf("api");
  if (api === -1) {
    return "https://app.langrelay.com";
  }
  labels[api] = "app";
  url.hostname = labels.join(".");
  return url.origin;
}

/** Where the person finds the Site's Change hook: the Site's Connection
 * once the plugin knows the Site, else the Dashboard's Sites. */
export function changeHookLink(apiOrigin: string, siteId?: string): string {
  const dashboard = dashboardOrigin(apiOrigin);
  return siteId === undefined
    ? `${dashboard}/sites`
    : `${dashboard}/sites/${encodeURIComponent(siteId)}/connection#change-hook`;
}

/** A delivery's body (the Change hook contract v1, vendored under
 * `contract/hooks/v1/`). */
export interface DeliveryBody {
  readonly removed?: readonly Removal[];
  readonly urls: readonly string[];
}

/** A page whose URL no longer serves it: gone, or moved to `movedTo`. */
export interface Removal {
  readonly movedTo?: string;
  readonly url: string;
}

export type Delivered =
  /** The hook took it: what LangRelay started, and the hook's Site. */
  | {
      readonly crawl: boolean;
      readonly ignored: number;
      readonly kind: "accepted";
      readonly pages: number;
      readonly siteId: string;
    }
  /** The token is unknown, revoked or rotated: one `404`. */
  | { readonly kind: "refused" }
  /** Try again later: a `429`, a fault, or the network. */
  | { readonly kind: "retry"; readonly reason: string }
  | { readonly kind: "not_connected" };

/** Send one delivery to the hook. Never throws. */
export async function deliver(
  ctx: PluginContext,
  body: DeliveryBody | { readonly crawl: true },
  hook?: ChangeHook | null,
): Promise<Delivered> {
  const target = hook ?? (await readHook(ctx));
  if (target === null) {
    return { kind: "not_connected" };
  }
  if (ctx.http === undefined) {
    return { kind: "retry", reason: "no_network_capability" };
  }
  let response: Response;
  try {
    response = await ctx.http.fetch(hookUrl(target), {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch (error) {
    // The token is in the URL: log the error's name only.
    ctx.log.warn("langrelay.delivery_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return { kind: "retry", reason: "network" };
  }
  if (response.status === 404) {
    return { kind: "refused" };
  }
  if (response.status !== 202) {
    return { kind: "retry", reason: `status_${response.status}` };
  }
  const answer = (await response.json().catch(() => null)) as {
    crawl?: unknown;
    ignored?: unknown;
    pages?: unknown;
    siteId?: unknown;
  } | null;
  return {
    crawl: answer?.crawl === true,
    ignored: typeof answer?.ignored === "number" ? answer.ignored : 0,
    kind: "accepted",
    pages: typeof answer?.pages === "number" ? answer.pages : 0,
    siteId: typeof answer?.siteId === "string" ? answer.siteId : "",
  };
}

/** What the admin page shows about the connection, kept in KV. */
export interface ConnectionStatus {
  readonly checkedAt: string;
  /** The last report's entries on another origin than the Site's. */
  readonly ignored?: number;
  readonly lastReportAt?: string;
  readonly siteId?: string;
  readonly state: "connected" | "failed";
}

const STATUS_KEY = "status";

export const readStatus = (ctx: PluginContext) =>
  ctx.kv.get<ConnectionStatus>(STATUS_KEY);

/** Record what a delivery said about the connection. */
export async function recordDelivery(
  ctx: PluginContext,
  delivered: Delivered,
  options: { readonly report: boolean },
): Promise<void> {
  const now = new Date().toISOString();
  const previous = await readStatus(ctx);
  if (delivered.kind === "accepted") {
    await ctx.kv.set(STATUS_KEY, {
      checkedAt: now,
      ...(options.report
        ? { ignored: delivered.ignored, lastReportAt: now }
        : {
            ...(previous?.ignored === undefined
              ? {}
              : { ignored: previous.ignored }),
            ...(previous?.lastReportAt === undefined
              ? {}
              : { lastReportAt: previous.lastReportAt }),
          }),
      ...(delivered.siteId ? { siteId: delivered.siteId } : {}),
      state: "connected",
    } satisfies ConnectionStatus);
  } else if (delivered.kind === "refused") {
    await ctx.kv.set(STATUS_KEY, {
      checkedAt: now,
      ...(previous?.siteId === undefined ? {} : { siteId: previous.siteId }),
      state: "failed",
    } satisfies ConnectionStatus);
  }
}
