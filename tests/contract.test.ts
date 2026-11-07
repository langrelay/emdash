import {
  createPluginRuntimeTestHost,
  type PluginRuntimeTestHost,
} from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";
import notFound from "../contract/hooks/v1/deliver-not-found.json";
import rateLimited from "../contract/hooks/v1/deliver-rate-limited.json";
import removed from "../contract/hooks/v1/deliver-removed.json";
import test from "../contract/hooks/v1/deliver-test.json";
import urls from "../contract/hooks/v1/deliver-urls.json";
import { embedFragment, parseSnippet } from "../src/snippet";

/**
 * The plugin against the Change hook contract it vendors
 * (`contract/hooks/v1/`, a copy of LangRelay's own; `pnpm check:contract`
 * keeps the copy honest): what it sends has each fixture's request shape,
 * and it reads each fixture's answer as the fixture says.
 */

const TOKEN = `lrh_chk_abc123_${"A".repeat(43)}`;
const HOOK = `https://api.langrelay.com/v1/hooks/${TOKEN}`;
const SITE = "https://hooks.example.com";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

/** A fixture's answer as a `Response`, its placeholders filled. */
const answer = (fixture: {
  readonly response: {
    readonly body: unknown;
    readonly headers: Record<string, string>;
    readonly status: number;
  };
}) =>
  new Response(
    JSON.stringify(fixture.response.body).replace("{{siteId}}", "site_1"),
    {
      headers: Object.fromEntries(
        Object.entries(fixture.response.headers).map(([name, value]) => [
          name,
          value.replace("{{retryAfter}}", "30"),
        ]),
      ),
      status: fixture.response.status,
    },
  );

const sent = (target: PluginRuntimeTestHost) =>
  target.http
    .requests()
    .filter((request) => request.url === HOOK)
    .map((request) => ({
      body: JSON.parse(new TextDecoder().decode(request.body)),
      contentType: request.headers["content-type"],
      method: request.method,
    }));

async function setup() {
  const target = await createPluginRuntimeTestHost({
    site: { locale: "en", url: SITE },
  });
  host = target;
  await target.fixtures.collection({
    fields: [{ label: "Title", slug: "title", type: "string" }],
    label: "Posts",
    slug: "posts",
    urlPattern: "/blog/{slug}",
  } as never);
  return target;
}

describe("the Change hook contract v1", () => {
  it("deliver-test: connecting sends the fixture's body, and its 202 reads as connected to its Site", async () => {
    const target = await setup();
    await target.http.respond(HOOK, answer(test));
    const page = await target.admin.submit("/connection", "connect", {
      hook: HOOK,
    });
    expect(sent(target)).toEqual([
      {
        body: test.request.body,
        contentType: test.request.headers["content-type"],
        method: test.request.method,
      },
    ]);
    expect(page.toast?.type).toBe("success");
    expect(JSON.stringify(page.blocks)).toContain("/sites/site_1/connection");
  });

  it("deliver-not-found: the 404 reads as a refused hook", async () => {
    const target = await setup();
    await target.http.respond(HOOK, answer(notFound));
    const page = await target.admin.submit("/connection", "connect", {
      hook: HOOK,
    });
    expect(page.toast?.message).toContain("did not accept this change hook");
  });

  it("deliver-urls and deliver-removed: a publish, a move and an unpublish send the fixtures' shapes", async () => {
    const target = await setup();
    await target.http.respond(HOOK, answer(test));
    await target.admin.submit("/connection", "connect", { hook: HOOK });
    const created = await target.actions.content.create("posts", {
      data: { title: "Old" },
      slug: "old-slug",
    } as never);
    if (!created.success) {
      throw new Error(created.error.message);
    }
    const id = created.data.item.id;
    await target.http.respond(HOOK, answer(urls));
    await target.actions.content.publish("posts", id);
    await target.waitForDeferredTasks();
    await target.http.respond(HOOK, answer(removed));
    await target.actions.content.update("posts", id, {
      slug: "new-slug",
    } as never);
    await target.waitForDeferredTasks();
    await target.http.respond(HOOK, answer(removed));
    await target.actions.content.unpublish("posts", id);
    await target.waitForDeferredTasks();

    const [, publish, move, gone] = sent(target).map((request) => request.body);
    expect(Object.keys(publish).sort()).toEqual(
      Object.keys({ urls: urls.request.body.urls }).sort(),
    );
    expect(publish.urls).toEqual([`${SITE}/blog/old-slug`]);
    // The fixture's own removals: one moved, one gone, with these keys.
    const [fixtureGone, fixtureMoved] = removed.request.body.removed;
    expect(Object.keys(move.removed[0]).sort()).toEqual(
      Object.keys(fixtureMoved ?? {}).sort(),
    );
    expect(move.removed[0]).toEqual({
      movedTo: `${SITE}/blog/new-slug`,
      url: `${SITE}/blog/old-slug`,
    });
    expect(Object.keys(gone.removed[0]).sort()).toEqual(
      Object.keys(fixtureGone ?? {}).sort(),
    );
    expect(gone.removed[0]).toEqual({ url: `${SITE}/blog/new-slug` });
  });

  it("deliver-rate-limited: the 429 keeps the change for the next sync", async () => {
    const target = await setup();
    await target.http.respond(HOOK, answer(test));
    await target.admin.submit("/connection", "connect", { hook: HOOK });
    const created = await target.actions.content.create("posts", {
      data: { title: "Busy" },
      slug: "busy",
    } as never);
    if (!created.success) {
      throw new Error(created.error.message);
    }
    await target.http.respond(HOOK, answer(rateLimited));
    await target.actions.content.publish("posts", created.data.item.id);
    await target.waitForDeferredTasks();
    expect(await target.inspect.kv.get("queue")).toEqual({
      crawl: false,
      removed: [],
      urls: [`${SITE}/blog/busy`],
    });
  });
});

describe("the Script embed snippet (trusted npm install only)", () => {
  const pinned = `<script src="https://api.langrelay.com/v1/client/sdk/1.0.0/langrelay.js"
    integrity="sha384-${"A".repeat(64)}"
    crossorigin="anonymous" referrerpolicy="no-referrer"
    data-langrelay-site-key="lrk_abc123" defer></script>`;

  it("the Dashboard's snippet becomes the same tag in the page's head", () => {
    const embed = parseSnippet(pinned);
    expect(embed).not.toBeNull();
    expect(embed === null ? null : embedFragment(embed)).toEqual({
      attributes: {
        crossorigin: "anonymous",
        "data-langrelay-site-key": "lrk_abc123",
        integrity: `sha384-${"A".repeat(64)}`,
        referrerpolicy: "no-referrer",
      },
      defer: true,
      key: "langrelay-script-embed",
      kind: "external-script",
      placement: "head",
      src: "https://api.langrelay.com/v1/client/sdk/1.0.0/langrelay.js",
    });
  });

  it("anything else is refused, so a typo never reaches a page", () => {
    for (const snippet of [
      "",
      "<script>alert(1)</script>",
      pinned.replace("https://", "http://"),
      pinned.replace("lrk_abc123", "nope"),
      `${pinned}<script src="https://evil.example"></script>`,
    ]) {
      expect(parseSnippet(snippet), snippet).toBeNull();
    }
  });
});
