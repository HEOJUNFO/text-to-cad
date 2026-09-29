import { createPromptContext, textPart } from "@text-to-cad/core/prompt";
import type { PromptContextPort } from "@text-to-cad/core/prompt";
import type { ClipboardPort, ViewerHost, ViewerLoadFailure } from "@text-to-cad/ui/host";

// Failures the CAD runtime reported while building a file; `undefined` is a STEP artifact
// the runtime could not produce. A mesh that fails to read keeps the card's own words.
const BUILD_FAILURES = new Set([undefined, "compile", "service", "http", "response"]);

/** The diagnostic as the agent receives it: what failed, and the runtime's complete output. */
export function loadFailurePrompt(failure: ViewerLoadFailure): string {
  const file = failure.file ? `“${failure.file}”` : "this file";
  const diagnostic = failure.details || failure.reason || failure.message || failure.title;
  return `The CAD viewer could not build ${file}: ${failure.title}. Fix the source so it builds, then rebuild it.\n\n\`\`\`\n${diagnostic}\n\`\`\``;
}

/**
 * The desktop has no viewer terminal or address to check: the runtime is in the app, and
 * the next step is the session's agent. A build failure says the runtime reported it, with
 * the interpreter's words beneath; every failure offers the diagnostic to the session's
 * prompt (the same delivery "Add to prompt" uses) and to the clipboard, beside Try again.
 */
export function createDesktopLoadFailures(promptContext: PromptContextPort, clipboard: ClipboardPort): NonNullable<ViewerHost["loadFailures"]> {
  return {
    recover(failure) {
      const kept = failure.blocking ? "" : " The previous version stays on screen.";
      const text = loadFailurePrompt(failure);
      const words = BUILD_FAILURES.has(failure.kind)
        ? { message: `The CAD runtime reported an error building ${failure.file ? `“${failure.file}”` : "this file"}.${kept}`,
            recovery: "Ask the agent to fix the source, or copy the details." }
        : failure.kind === "network"
          ? { message: `The app lost contact with the CAD runtime while loading ${failure.file ? `“${failure.file}”` : "this file"}.${kept}`,
              recovery: "Try again. If it keeps happening, copy the details." }
          : {};
      return {
        ...words,
        actions: [
          {
            label: "Ask the agent to fix",
            run: async () => {
              const result = await promptContext.deliver(createPromptContext([textPart(text, "load-failure")]));
              if (result.status === "failed" || result.status === "partial") throw new Error(result.message || "Could not add the error to the prompt.");
              // A destination that went away (the session was archived) cancels with its reason.
              return result.status === "added" ? "Added to the prompt." : "message" in result ? result.message ?? "" : "";
            },
          },
          {
            label: "Copy details",
            run: async () => { await clipboard.writeText(failure.details || text); return "Copied."; },
          },
        ],
      };
    },
  };
}
