/**
 * Tok-per-sec Extension - shows tokens/second for the last assistant reply
 *
 * Tracks token count and time delta of the most recent assistant message
 * and displays the rate in the footer status bar.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let lastOutputTokens = 0;
  let lastStartTime = 0;

  // Record start time when the assistant message begins streaming
  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant" || !enabled) return;
    lastStartTime = Date.now();
  });

  // When the assistant message ends, calculate and display tok/s
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || !enabled) return;
    const elapsed = (Date.now() - lastStartTime) / 1000; // seconds
    const tps = elapsed > 0 && event.message.usage.output > 0
      ? Math.round((event.message.usage.output / elapsed) * 100) / 100 // 2 decimal places
      : 0;
    ctx.ui.setStatus("tok-s", tps > 0 ? `${tps} tok/s` : "");
  });

  // Reset when a new session starts
  pi.on("session_start", (event, ctx) => {
    if (event.reason === "new" || event.reason === "resume") {
      lastOutputTokens = 0;
      lastStartTime = 0;
      ctx.ui.setStatus("tok-s", "");
    }
  });

  // Toggle command
  pi.registerCommand("tok-per-sec", {
    description: "Toggle tokens/sec display in footer",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      ctx.ui.setStatus("tok-s", ""); // Clear when disabled
      ctx.ui.notify(
        enabled ? "tok/s enabled" : "tok/s disabled",
        "info",
      );
    },
  });
}
