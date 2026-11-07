import type { PluginContext } from "emdash/plugin";
import {
  type DeliveryBody,
  deliver,
  type Removal,
  recordDelivery,
} from "./connection";

/**
 * Change reports: every change to a live page goes to the Site's Change
 * hook when it happens. What could not be sent waits in a bounded queue,
 * which the `cron` hook sends again.
 *
 * EmDash answers no public URL for an item that is no longer published, so
 * the plugin keeps each published item's URL (`url:<collection>:<id>`) and
 * reports that one when the item is unpublished, deleted or moved.
 */

/** At most this many entries of `urls` or `removed` in one delivery: the
 * contract's limit. */
export const DELIVERY_MAX = 100;
/** At most this many entries wait. Past it the queue becomes one crawl of
 * the whole Site, which finds every change. */
export const QUEUE_MAX = 500;
/** At most this many deliveries in one flush, so a tick stays short; the
 * hook takes 60 a minute. */
export const FLUSH_MAX_DELIVERIES = 5;
/** Items recorded per backfill step. */
export const BACKFILL_BATCH = 100;
/** Attempts at a contended KV write before giving up. */
const CAS_ATTEMPTS = 5;

/** The `cron` task that resends what waits and records older URLs. */
export const SYNC_TASK = "langrelay-sync";
const SYNC_SCHEDULE = "*/5 * * * *";

/**
 * Schedule the sync task. An upsert, so it is called wherever the task is
 * needed: on activation, on connecting, and whenever a report waits. A
 * plugin configured in `astro.config` is enabled without ever being
 * activated, so activation alone would leave it unscheduled.
 */
export async function ensureSync(ctx: PluginContext): Promise<void> {
  await ctx.cron?.schedule(SYNC_TASK, { schedule: SYNC_SCHEDULE });
}

const QUEUE_KEY = "queue";
const BACKFILL_KEY = "backfill";
const urlKey = (collection: string, id: string) => `url:${collection}:${id}`;

interface Queue {
  /** More changes than the queue holds: send one crawl instead. */
  readonly crawl: boolean;
  readonly removed: readonly Removal[];
  readonly urls: readonly string[];
}

const EMPTY: Queue = { crawl: false, removed: [], urls: [] };

/** Whether an item's save changed its live page: it is published, and no
 * draft revision is waiting (a draft-revision collection's save changes
 * only the draft until it is published, which fires `afterPublish`). */
export function changedLive(content: Record<string, unknown>): boolean {
  if (content.status !== "published") {
    return false;
  }
  const draft = content.draftRevisionId;
  return (
    draft === null || draft === undefined || draft === content.liveRevisionId
  );
}

/** Whether an item is in the site's own locale. LangRelay translates the
 * source; EmDash's own translations of it are never sent. */
function inSourceLocale(
  content: Record<string, unknown>,
  siteLocale: string,
): boolean {
  const locale = content.locale;
  return (
    locale === null ||
    locale === undefined ||
    (typeof locale === "string" &&
      locale.toLowerCase() === siteLocale.toLowerCase())
  );
}

/** Change the queue with a compare-and-set, so two hooks at once never
 * drop each other's changes. */
async function updateQueue(
  ctx: PluginContext,
  change: (queue: Queue) => Queue,
): Promise<void> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: a retry, at most CAS_ATTEMPTS.
    const current = await ctx.kv.getVersioned<Queue>(QUEUE_KEY);
    const next = change(current?.value ?? EMPTY);
    const written = await ctx.kv.compareAndSet(
      QUEUE_KEY,
      current?.revision ?? null,
      next,
    );
    if (written.applied) {
      return;
    }
  }
  ctx.log.warn("langrelay.queue_contended", {});
}

/** Add what could not be sent. A removal replaces the same URL's earlier
 * entry; past {@link QUEUE_MAX} the queue is one crawl. */
export function enqueued(queue: Queue, body: DeliveryBody): Queue {
  if (queue.crawl) {
    return queue;
  }
  const removed = new Map(queue.removed.map((entry) => [entry.url, entry]));
  for (const entry of body.removed ?? []) {
    removed.set(entry.url, entry);
  }
  const urls = new Set(queue.urls);
  for (const url of body.urls) {
    urls.add(url);
  }
  if (urls.size + removed.size > QUEUE_MAX) {
    return { crawl: true, removed: [], urls: [] };
  }
  return { crawl: false, removed: [...removed.values()], urls: [...urls] };
}

export const readQueue = async (ctx: PluginContext): Promise<Queue> =>
  (await ctx.kv.get<Queue>(QUEUE_KEY)) ?? EMPTY;

/** Report one change now; keep it for the next flush if it cannot go. */
export async function report(
  ctx: PluginContext,
  body: DeliveryBody,
): Promise<void> {
  const delivered = await deliver(ctx, body);
  await recordDelivery(ctx, delivered, { report: true });
  if (delivered.kind === "retry" || delivered.kind === "refused") {
    // Kept until the hook answers again (or a new one is pasted).
    await updateQueue(ctx, (queue) => enqueued(queue, body));
    await ensureSync(ctx);
  }
}

/** A published item changed: report its URL, or its move. */
export async function reportLive(
  ctx: PluginContext,
  collection: string,
  content: Record<string, unknown>,
): Promise<void> {
  const id = content.id;
  if (typeof id !== "string" || !inSourceLocale(content, ctx.site.locale)) {
    return;
  }
  const url = await ctx.content?.getPublicUrl?.(collection, id);
  if (!url) {
    return;
  }
  const key = urlKey(collection, id);
  const previous = await ctx.kv.get<string>(key);
  await ctx.kv.set(key, url);
  await report(
    ctx,
    previous && previous !== url
      ? { removed: [{ movedTo: url, url: previous }], urls: [] }
      : { urls: [url] },
  );
}

/** An item left its URL (unpublished, trashed, deleted): report it gone. */
export async function reportGone(
  ctx: PluginContext,
  collection: string,
  id: string,
): Promise<void> {
  const key = urlKey(collection, id);
  const previous = await ctx.kv.get<string>(key);
  if (!previous) {
    return;
  }
  await ctx.kv.delete(key);
  await report(ctx, { removed: [{ url: previous }], urls: [] });
}

/** Send what waits, at most {@link FLUSH_MAX_DELIVERIES} deliveries. */
export async function flush(ctx: PluginContext): Promise<void> {
  for (let sent = 0; sent < FLUSH_MAX_DELIVERIES; sent += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one delivery at a time, bounded.
    const current = await ctx.kv.getVersioned<Queue>(QUEUE_KEY);
    const queue = current?.value ?? EMPTY;
    if (!queue.crawl && queue.urls.length === 0 && queue.removed.length === 0) {
      return;
    }
    const body: DeliveryBody | { readonly crawl: true } = queue.crawl
      ? { crawl: true }
      : {
          removed: queue.removed.slice(0, DELIVERY_MAX),
          urls: queue.urls.slice(0, DELIVERY_MAX),
        };
    const delivered = await deliver(ctx, body);
    await recordDelivery(ctx, delivered, { report: true });
    if (delivered.kind !== "accepted") {
      return;
    }
    const sentUrls = new Set("urls" in body ? body.urls : []);
    const sentRemoved = new Set(
      "removed" in body ? (body.removed ?? []).map((entry) => entry.url) : [],
    );
    // Take off only what was sent: a hook may have added more meanwhile.
    await updateQueue(ctx, (latest) =>
      queue.crawl
        ? EMPTY
        : {
            crawl: latest.crawl,
            removed: latest.removed.filter(
              (entry) => !sentRemoved.has(entry.url),
            ),
            urls: latest.urls.filter((url) => !sentUrls.has(url)),
          },
    );
  }
}

interface Backfill {
  readonly collections: readonly string[];
  readonly cursor?: string;
  readonly done: boolean;
  readonly index: number;
}

/**
 * Record the URLs of items published before the plugin was connected, so
 * their later removal can be reported. {@link BACKFILL_BATCH} items a step;
 * the `cron` hook takes the next step until it is done. Sends nothing.
 */
export async function backfillStep(ctx: PluginContext): Promise<void> {
  if (ctx.schema === undefined || ctx.content === undefined) {
    return;
  }
  let state = await ctx.kv.get<Backfill>(BACKFILL_KEY);
  if (state === null) {
    const collections = (await ctx.schema.listCollections())
      .filter((collection) => collection.routable)
      .map((collection) => collection.slug);
    state = { collections, done: false, index: 0 };
  }
  if (state.done) {
    return;
  }
  const collection = state.collections[state.index];
  if (collection === undefined) {
    await ctx.kv.set(BACKFILL_KEY, { ...state, done: true });
    return;
  }
  const page = await ctx.content.list(collection, {
    limit: BACKFILL_BATCH,
    where: { status: "published" },
    ...(state.cursor === undefined ? {} : { cursor: state.cursor }),
  });
  for (const item of page.items) {
    if (!inSourceLocale({ locale: item.locale }, ctx.site.locale)) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: at most BACKFILL_BATCH reads a step.
    const url = await ctx.content.getPublicUrl?.(collection, item.id);
    if (url) {
      await ctx.kv.set(urlKey(collection, item.id), url);
    }
  }
  await ctx.kv.set(
    BACKFILL_KEY,
    page.cursor
      ? { ...state, cursor: page.cursor }
      : { collections: state.collections, done: false, index: state.index + 1 },
  );
}

/** Start the backfill again from the first collection (on a new hook). */
export const restartBackfill = (ctx: PluginContext) =>
  ctx.kv.delete(BACKFILL_KEY);
