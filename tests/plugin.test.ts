import {
  createPluginRuntimeTestHost,
  type PluginRuntimeTestHost,
} from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The plugin in EmDash's own runtime: real content actions fire its hooks,
 * its outbound requests are answered here, and its admin page is driven as
 * the admin would drive it. Each case is a way the plugin could fail its
 * promise: "every change to a live page reaches LangRelay at once, and the
 * person can tell whether it is connected".
 */

const SITE = "https://shop.example.com";
const TOKEN = `lrh_chk_abc123_${"A".repeat(43)}`;
const HOOK = `https://api.langrelay.com/v1/hooks/${TOKEN}`;

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

const accepted = (pages = 1) =>
  new Response(
    JSON.stringify({ crawl: false, ignored: 0, pages, siteId: "site_1" }),
    { headers: { "content-type": "application/json" }, status: 202 },
  );

/** What the plugin sent to the hook, in order. */
const sent = (target: PluginRuntimeTestHost) =>
  target.http
    .requests()
    .filter((request) => request.url === HOOK)
    .map((request) => JSON.parse(new TextDecoder().decode(request.body)));

async function setup(
  options: { readonly activate?: boolean; readonly revisions?: boolean } = {},
) {
  const target = await createPluginRuntimeTestHost({
    site: { locale: "en", url: SITE },
  });
  host = target;
  if (options.activate !== false) {
    await target.actions.plugin.activate();
  }
  await target.fixtures.collection({
    fields: [{ label: "Title", slug: "title", type: "string" }],
    label: "Posts",
    slug: "posts",
    ...(options.revisions ? { supports: ["drafts", "revisions"] } : {}),
    urlPattern: "/blog/{slug}",
  } as never);
  return target;
}

async function connect(target: PluginRuntimeTestHost, pasted = HOOK) {
  await target.http.respond(HOOK, accepted(0));
  return await target.admin.submit("/connection", "connect", { hook: pasted });
}

async function publishedPost(target: PluginRuntimeTestHost, slug: string) {
  const created = await target.actions.content.create("posts", {
    data: { title: slug },
    slug,
  } as never);
  if (!created.success) {
    throw new Error(created.error.message);
  }
  const id = created.data.item.id;
  await target.http.respond(HOOK, accepted());
  const published = await target.actions.content.publish("posts", id);
  if (!published.success) {
    throw new Error(published.error.message);
  }
  await target.waitForDeferredTasks();
  return id;
}

const text = (value: unknown) => JSON.stringify(value);

describe("connecting", () => {
  it("a pasted hook URL is proved by a test report that starts nothing, kept encrypted, and the page says connected and links to the Site's change hook", async () => {
    const target = await setup();
    const page = await connect(target);

    expect(sent(target)).toEqual([{ urls: [] }]);
    expect(page.toast).toEqual({
      message: "Connected to LangRelay",
      type: "success",
    });
    expect(text(page.blocks)).toContain("Connected to LangRelay");
    expect(text(page.blocks)).toContain(
      "https://app.langrelay.com/sites/site_1/connection#change-hook",
    );
    const raw = await target.inspect.settings.raw("hook");
    expect(text(raw)).not.toContain(TOKEN);
  });

  it("connecting schedules the sync task, even on a site that never activated the plugin (a plugin configured in astro.config)", async () => {
    const target = await setup({ activate: false });
    expect(await target.inspect.scheduledTasks()).toEqual([]);
    await connect(target);
    expect(
      (await target.inspect.scheduledTasks()).map((task) => task.name),
    ).toEqual(["langrelay-sync"]);
  });

  it("on a site with no EMDASH_ENCRYPTION_KEY, connecting says what to set and keeps nothing", async () => {
    const target = await setup();
    const key = process.env.EMDASH_ENCRYPTION_KEY;
    delete process.env.EMDASH_ENCRYPTION_KEY;
    try {
      const page = await connect(target);
      expect(page.toast?.type).toBe("error");
      expect(page.toast?.message).toContain("EMDASH_ENCRYPTION_KEY");
      expect(await target.inspect.settings.raw("hook")).toBeNull();
    } finally {
      process.env.EMDASH_ENCRYPTION_KEY = key;
    }
  });

  it("the bare token works too, and is sent to api.langrelay.com", async () => {
    const target = await setup();
    const page = await connect(target, `  ${TOKEN}\n`);
    expect(page.toast?.type).toBe("success");
    expect(sent(target)).toEqual([{ urls: [] }]);
  });

  it("a hook LangRelay refuses (revoked, rotated) is not kept, and the page says why", async () => {
    const target = await setup();
    await target.http.respond(HOOK, new Response("{}", { status: 404 }));
    const page = await target.admin.submit("/connection", "connect", {
      hook: HOOK,
    });
    expect(page.toast?.type).toBe("error");
    expect(page.toast?.message).toContain("did not accept this change hook");
    expect(await target.inspect.setting("hook")).toBeNull();
    expect(text(page.blocks)).toContain("Not connected");
  });

  it("anything that is not a change hook is refused before anything is sent", async () => {
    const target = await setup();
    for (const pasted of [
      "https://api.langrelay.com/v1/hooks/not-a-token",
      `http://api.langrelay.com/v1/hooks/${TOKEN}`,
      "hello",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one paste at a time.
      const page = await target.admin.submit("/connection", "connect", {
        hook: pasted,
      });
      expect(page.toast?.type, pasted).toBe("error");
    }
    expect(target.http.requests()).toEqual([]);
  });

  it("before connecting, the page says so and links to LangRelay's Sites; it never promises a switcher", async () => {
    const target = await setup();
    const page = await target.admin.loadPage("/connection");
    expect(text(page.blocks)).toContain("Not connected");
    expect(text(page.blocks)).toContain("https://app.langrelay.com/sites");
    expect(text(page.blocks)).toContain("adds none of them to your pages");
  });
});

describe("a site with no URL", () => {
  it("the page says the plugin cannot name pages until the site's URL is set", async () => {
    const target = await createPluginRuntimeTestHost({
      site: { locale: "en", url: "" },
    });
    host = target;
    const page = await target.admin.loadPage("/connection");
    expect(text(page.blocks)).toContain("This site has no URL");
  });
});

describe("reporting changes", () => {
  it("a publish reports the item's public URL at once", async () => {
    const target = await setup();
    await connect(target);
    await publishedPost(target, "hello");
    expect(sent(target).at(-1)).toEqual({ urls: [`${SITE}/blog/hello`] });
  });

  it("a slug change on a live item reports the old URL moved to the new one", async () => {
    const target = await setup();
    await connect(target);
    const id = await publishedPost(target, "old-slug");
    await target.http.respond(HOOK, accepted());
    const updated = await target.actions.content.update("posts", id, {
      slug: "new-slug",
    } as never);
    expect(updated.success).toBe(true);
    await target.waitForDeferredTasks();
    expect(sent(target).at(-1)).toEqual({
      removed: [
        { movedTo: `${SITE}/blog/new-slug`, url: `${SITE}/blog/old-slug` },
      ],
      urls: [],
    });
  });

  it("an unpublish reports the URL gone", async () => {
    const target = await setup();
    await connect(target);
    const id = await publishedPost(target, "leaving");
    await target.http.respond(HOOK, accepted());
    await target.actions.content.unpublish("posts", id);
    await target.waitForDeferredTasks();
    expect(sent(target).at(-1)).toEqual({
      removed: [{ url: `${SITE}/blog/leaving` }],
      urls: [],
    });
  });

  it("a trashed item reports its URL gone", async () => {
    const target = await setup();
    await connect(target);
    const id = await publishedPost(target, "trashed");
    await target.http.respond(HOOK, accepted());
    await target.actions.content.trash("posts", id);
    await target.waitForDeferredTasks();
    expect(sent(target).at(-1)).toEqual({
      removed: [{ url: `${SITE}/blog/trashed` }],
      urls: [],
    });
  });

  it("a draft that was never published reports nothing", async () => {
    const target = await setup();
    await connect(target);
    await target.actions.content.create("posts", {
      data: { title: "draft" },
      slug: "draft",
    } as never);
    await target.waitForDeferredTasks();
    expect(sent(target)).toEqual([{ urls: [] }]);
  });

  it("in a collection with draft revisions, a saved draft of a live page sends nothing until it is published", async () => {
    const target = await setup({ revisions: true });
    await connect(target);
    const id = await publishedPost(target, "revised");
    const before = sent(target).length;
    const saved = await target.actions.content.update("posts", id, {
      data: { title: "A new title, still a draft" },
    } as never);
    expect(saved.success).toBe(true);
    await target.waitForDeferredTasks();
    expect(sent(target)).toHaveLength(before);

    await target.http.respond(HOOK, accepted());
    await target.actions.content.publish("posts", id);
    await target.waitForDeferredTasks();
    expect(sent(target).at(-1)).toEqual({ urls: [`${SITE}/blog/revised`] });
  });

  it("an item published before connecting is still reported gone when it is unpublished", async () => {
    const target = await setup();
    // Published while the plugin had no hook: nothing is sent.
    const id = await publishedPost(target, "older");
    target.http.clear();
    await connect(target);
    await target.http.respond(HOOK, accepted());
    await target.actions.content.unpublish("posts", id);
    await target.waitForDeferredTasks();
    expect(sent(target).at(-1)).toEqual({
      removed: [{ url: `${SITE}/blog/older` }],
      urls: [],
    });
  });
});

describe("when LangRelay cannot take a report", () => {
  it("a report answered 429 waits and is sent by the next sync; the page says it waits", async () => {
    const target = await setup();
    await connect(target);
    await target.http.respond(
      HOOK,
      new Response("{}", { headers: { "retry-after": "30" }, status: 429 }),
    );
    const id = await target.actions.content.create("posts", {
      data: { title: "busy" },
      slug: "busy",
    } as never);
    if (!id.success) {
      throw new Error(id.error.message);
    }
    await target.actions.content.publish("posts", id.data.item.id);
    await target.waitForDeferredTasks();
    expect(text((await target.admin.loadPage("/connection")).blocks)).toContain(
      "1 change(s) are waiting",
    );

    await target.http.respond(HOOK, accepted());
    await target.transport.invokeHook("cron", {
      name: "langrelay-sync",
      scheduledAt: new Date().toISOString(),
    });
    expect(sent(target).at(-1)).toEqual({
      removed: [],
      urls: [`${SITE}/blog/busy`],
    });
    expect(await target.inspect.kv.get("queue")).toEqual({
      crawl: false,
      removed: [],
      urls: [],
    });
  });

  it("past the queue's bound, what waits becomes one crawl of the whole Site", async () => {
    const target = await setup();
    await connect(target);
    await target.fixtures.plugin.kv("queue", {
      crawl: false,
      removed: [],
      urls: Array.from({ length: 500 }, (_, index) => `${SITE}/p/${index}`),
    });
    await target.http.respond(HOOK, new Response("{}", { status: 503 }));
    await publishedPost(target, "one-more").catch(() => undefined);
    await target.waitForDeferredTasks();
    expect(await target.inspect.kv.get("queue")).toEqual({
      crawl: true,
      removed: [],
      urls: [],
    });
    await target.http.respond(HOOK, accepted(0));
    await target.transport.invokeHook("cron", {
      name: "langrelay-sync",
      scheduledAt: new Date().toISOString(),
    });
    expect(sent(target).at(-1)).toEqual({ crawl: true });
  });

  it("the sync task is scheduled when the plugin is activated", async () => {
    const target = await setup();
    expect(
      (await target.inspect.scheduledTasks()).map((task) => [
        task.name,
        task.schedule,
      ]),
    ).toEqual([["langrelay-sync", "*/5 * * * *"]]);
  });
});
