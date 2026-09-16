/**
 * reload-runtime — let the agent trigger a full /reload via a tool call.
 *
 * Tools run with ExtensionContext and cannot call ctx.reload() directly, so
 * this registers a `reload_runtime` tool that queues "/reload" as a follow-up
 * user message (the pattern documented in pi's extensions.md, "ctx.reload()").
 * The reload happens automatically as soon as the current turn ends.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description:
      "Queue a full /reload (extensions, skills, prompts, themes, context files) as a follow-up. The reload runs automatically when the current turn ends. Use after writing/changing extensions, skills, AGENTS.md, settings, or models when the user wants changes applied without manually typing /reload.",
    parameters: Type.Object({}),
    async execute() {
      pi.sendUserMessage("/reload", { deliverAs: "followUp" });
      return {
        content: [
          {
            type: "text" as const,
            text: "Queued /reload as a follow-up — extensions, skills, prompts, themes, and context files will be reloaded when this turn ends.",
          },
        ],
      };
    },
  });
}
