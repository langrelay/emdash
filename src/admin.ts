import type { BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";
import { z } from "zod";
import {
  changeHookLink,
  DEFAULT_API_ORIGIN,
  deliver,
  HOOK_SETTING,
  hookUrl,
  parseHook,
  readHook,
  readStatus,
  recordDelivery,
} from "./connection";
import {
  backfillStep,
  ensureSync,
  flush,
  readQueue,
  restartBackfill,
} from "./reports";
import { parseSnippet, SNIPPET_SETTING } from "./snippet";

/** The plugin's one admin page, as the manifest declares it. */
export const ADMIN_PAGE = "/connection";

const interaction = z.discriminatedUnion("type", [
  z.object({ page: z.string(), type: z.literal("page_load") }),
  z.object({
    action_id: z.string(),
    type: z.literal("block_action"),
    value: z.unknown().optional(),
  }),
  z.object({
    action_id: z.string(),
    type: z.literal("form_submit"),
    values: z.record(z.string(), z.unknown()),
  }),
]);

type Toast = NonNullable<BlockResponse["toast"]>;

const WHAT_IT_DOES =
  "LangRelay hears about every publish, update, slug change, unpublish and delete the moment it happens, so your translations follow your content.";
const DELIVERY =
  "Translated pages, hreflang tags and the language switcher come from LangRelay on your own domain (Proxy delivery). This plugin adds none of them to your pages.";
const SCRIPT_EMBED =
  "Using Script embed instead of a domain? Paste its snippet into your theme. Only a copy of this plugin installed with npm (`@langrelay/emdash-plugin/trusted`) can add the snippet for you; a marketplace install cannot add scripts to your pages.";

const NO_KEY_TEXT =
  "EmDash needs an encryption key to keep the change hook secret. Run `npx emdash secrets generate`, set EMDASH_ENCRYPTION_KEY in your site's environment, restart the site, and connect again.";

const REFUSED_TEXT =
  "LangRelay did not accept this change hook. It may have been revoked or replaced. Create a new one on your Site's Connection page and paste it here.";

const reasonText = {
  empty: "Paste your Site's change hook URL.",
  malformed:
    "That is not a change hook. Copy the URL from your Site's Connection page in LangRelay.",
  not_https: "A change hook URL starts with https://.",
} as const;

const formatTime = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** The page, as the plugin's state stands. */
export async function renderAdmin(
  ctx: PluginContext,
  toast?: Toast,
): Promise<BlockResponse> {
  const [hook, status, queue, snippet] = await Promise.all([
    readHook(ctx),
    readStatus(ctx),
    readQueue(ctx),
    ctx.settings.get<string>(SNIPPET_SETTING),
  ]);
  const apiOrigin = hook?.origin ?? DEFAULT_API_ORIGIN;
  const waiting = queue.crawl
    ? "Many changes are waiting; LangRelay will read your whole site when it can be reached."
    : queue.urls.length + queue.removed.length > 0
      ? `${queue.urls.length + queue.removed.length} change(s) are waiting to be sent. They are retried every five minutes.`
      : null;
  const blocks: BlockResponse["blocks"] = [
    { text: "LangRelay", type: "header" },
  ];

  if (hook === null) {
    blocks.push({
      description:
        "Create a change hook on your Site's Connection page in LangRelay, copy its URL and paste it below.",
      title: "Not connected",
      type: "banner",
      variant: "default",
    });
  } else if (status?.state === "failed") {
    blocks.push({
      description: REFUSED_TEXT,
      title: "Not connected",
      type: "banner",
      variant: "error",
    });
  } else {
    blocks.push({
      description: status?.lastReportAt
        ? `Last change sent ${formatTime(status.lastReportAt)}.`
        : `Checked ${status ? formatTime(status.checkedAt) : "just now"}.`,
      title: "Connected to LangRelay",
      type: "banner",
      variant: "default",
    });
  }
  if (!ctx.site.url) {
    // EmDash builds every public URL from the site's address, read when
    // the site starts: without one the plugin can name no page.
    blocks.push({
      description:
        "Set your site's URL in EmDash's settings, then restart the site. Until then the plugin cannot tell LangRelay which pages changed.",
      title: "This site has no URL",
      type: "banner",
      variant: "error",
    });
  }
  if ((status?.ignored ?? 0) > 0) {
    blocks.push({
      description: `LangRelay ignored ${status?.ignored} address(es) in the last report because they are not on your Site's address. Check that this site's URL, ${ctx.site.url}, is the address your LangRelay Site was created for.`,
      title: "Some changes were not for your Site",
      type: "banner",
      variant: "alert",
    });
  }
  if (waiting !== null) {
    blocks.push({ text: waiting, type: "context" });
  }
  blocks.push(
    {
      elements: [
        {
          appearance: "primary",
          label: status?.siteId
            ? "Open your Site's change hook"
            : "Open LangRelay",
          target: {
            kind: "external",
            url: changeHookLink(apiOrigin, status?.siteId),
          },
          type: "link",
        },
        ...(hook === null
          ? []
          : [
              {
                action_id: "test",
                label: "Send a test report",
                type: "button" as const,
              },
              {
                action_id: "disconnect",
                confirm: {
                  confirm: "Disconnect",
                  deny: "Cancel",
                  text: "LangRelay stops hearing about your changes until you paste a change hook again.",
                  title: "Disconnect from LangRelay?",
                },
                label: "Disconnect",
                style: "danger" as const,
                type: "button" as const,
              },
            ]),
      ],
      type: "actions",
    },
    {
      block_id: "connection",
      fields: [
        {
          action_id: "hook",
          has_value: hook !== null,
          label: "Change hook URL",
          placeholder: "https://api.langrelay.com/v1/hooks/lrh_…",
          type: "secret_input",
        },
      ],
      submit: { action_id: "connect", label: "Connect" },
      type: "form",
    },
    { text: WHAT_IT_DOES, type: "context" },
    { type: "divider" },
    { text: "Delivery", type: "header" },
    { text: DELIVERY, type: "section" },
    { text: SCRIPT_EMBED, type: "section" },
    {
      block_id: "script-embed",
      fields: [
        {
          action_id: "snippet",
          initial_value: typeof snippet === "string" ? snippet : "",
          label: "Script embed snippet (npm install only)",
          multiline: true,
          type: "text_input",
        },
      ],
      submit: { action_id: "save_snippet", label: "Save snippet" },
      type: "form",
    },
  );
  return { blocks, ...(toast === undefined ? {} : { toast }) };
}

/** Prove a hook with a test delivery, which starts nothing; keep it only
 * when LangRelay takes it. */
async function connect(ctx: PluginContext, pasted: unknown): Promise<Toast> {
  const stored = await readHook(ctx);
  if ((typeof pasted !== "string" || pasted.trim() === "") && stored !== null) {
    return await test(ctx);
  }
  const parsed = parseHook(typeof pasted === "string" ? pasted : "");
  if (!parsed.ok) {
    return { message: reasonText[parsed.reason], type: "error" };
  }
  const delivered = await deliver(ctx, { urls: [] }, parsed.hook);
  if (delivered.kind === "refused") {
    return { message: REFUSED_TEXT, type: "error" };
  }
  if (delivered.kind !== "accepted") {
    return {
      message:
        parsed.hook.origin === DEFAULT_API_ORIGIN
          ? "Could not reach LangRelay. Try again in a minute."
          : `Could not reach ${parsed.hook.origin}. This plugin can only reach the LangRelay API its manifest names.`,
      type: "error",
    };
  }
  try {
    await ctx.settings.set(HOOK_SETTING, hookUrl(parsed.hook));
  } catch (error) {
    // EmDash encrypts a secret setting with EMDASH_ENCRYPTION_KEY and
    // refuses to store one without it; never keep the hook in plain text.
    if (String(error).includes("EMDASH_ENCRYPTION_KEY")) {
      return { message: NO_KEY_TEXT, type: "error" };
    }
    throw error;
  }
  await ensureSync(ctx);
  await recordDelivery(ctx, delivered, { report: false });
  await restartBackfill(ctx);
  await backfillStep(ctx);
  await flush(ctx);
  return { message: "Connected to LangRelay", type: "success" };
}

async function test(ctx: PluginContext): Promise<Toast> {
  const delivered = await deliver(ctx, { urls: [] });
  await recordDelivery(ctx, delivered, { report: false });
  if (delivered.kind === "accepted") {
    await flush(ctx);
    return { message: "LangRelay received the test report", type: "success" };
  }
  return delivered.kind === "refused"
    ? { message: REFUSED_TEXT, type: "error" }
    : {
        message: "Could not reach LangRelay. Try again in a minute.",
        type: "error",
      };
}

/** The admin route: one Block Kit interaction in, the page out. */
export async function handleAdmin(
  input: unknown,
  ctx: PluginContext,
): Promise<BlockResponse> {
  const parsed = interaction.safeParse(input);
  if (!parsed.success) {
    return { blocks: [] };
  }
  const event = parsed.data;
  if (event.type === "page_load") {
    return await renderAdmin(ctx);
  }
  if (event.type === "form_submit" && event.action_id === "connect") {
    return await renderAdmin(ctx, await connect(ctx, event.values.hook));
  }
  if (event.type === "block_action" && event.action_id === "test") {
    return await renderAdmin(ctx, await test(ctx));
  }
  if (event.type === "block_action" && event.action_id === "disconnect") {
    await ctx.settings.delete(HOOK_SETTING);
    await ctx.kv.delete("status");
    return await renderAdmin(ctx, { message: "Disconnected", type: "success" });
  }
  if (event.type === "form_submit" && event.action_id === "save_snippet") {
    const value = event.values.snippet;
    if (typeof value !== "string" || value.trim() === "") {
      await ctx.settings.delete(SNIPPET_SETTING);
      return await renderAdmin(ctx, {
        message: "Snippet removed",
        type: "success",
      });
    }
    if (parseSnippet(value) === null) {
      return await renderAdmin(ctx, {
        message:
          "That is not LangRelay's Script embed snippet. Copy it from your Site's Connection page.",
        type: "error",
      });
    }
    await ctx.settings.set(SNIPPET_SETTING, value.trim());
    return await renderAdmin(ctx, {
      message: "Snippet saved",
      type: "success",
    });
  }
  return await renderAdmin(ctx);
}
