import type { SandboxedPlugin } from "emdash/plugin";
import { handleAdmin } from "./admin";
import {
  backfillStep,
  changedLive,
  ensureSync,
  flush,
  reportGone,
  reportLive,
  SYNC_TASK,
} from "./reports";
import { embedFragment, parseSnippet, SNIPPET_SETTING } from "./snippet";

/**
 * The LangRelay plugin for EmDash. It tells the Site's Change hook about
 * every change to a live page. It serves no pages: translated pages,
 * hreflang and the switcher come from LangRelay's Proxy delivery on the
 * site's own domain.
 */

const plugin: SandboxedPlugin = {
  hooks: {
    "content:afterDelete": async (event, ctx) => {
      await reportGone(ctx, event.collection, event.id);
    },
    "content:afterPublish": async (event, ctx) => {
      await reportLive(ctx, event.collection, event.content);
    },
    "content:afterRestore": async (event, ctx) => {
      await reportLive(ctx, event.collection, event.content);
    },
    "content:afterSave": async (event, ctx) => {
      if (changedLive(event.content)) {
        await reportLive(ctx, event.collection, event.content);
      }
    },
    "content:afterUnpublish": async (event, ctx) => {
      const id = event.content.id;
      if (typeof id === "string") {
        await reportGone(ctx, event.collection, id);
      }
    },
    cron: async (event, ctx) => {
      if (event.name !== SYNC_TASK) {
        return;
      }
      await flush(ctx);
      await backfillStep(ctx);
    },
    // Runs only in a trusted npm install whose manifest grants
    // `hooks.page-fragments:register` (`@langrelay/emdash-plugin/trusted`);
    // EmDash never calls it in the sandbox.
    "page:fragments": async (_event, ctx) => {
      const snippet = await ctx.settings.get<string>(SNIPPET_SETTING);
      const embed = typeof snippet === "string" ? parseSnippet(snippet) : null;
      return embed === null ? null : embedFragment(embed);
    },
    "plugin:activate": async (_event, ctx) => {
      await ensureSync(ctx);
    },
  },
  routes: {
    admin: {
      handler: async (routeCtx, ctx) => await handleAdmin(routeCtx.input, ctx),
    },
  },
};

export default plugin;
