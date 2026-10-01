import { issueUrl } from "../../../file-viewer/navigation/links.js";

// The failure as the card shows it, bold: its first line, no longer than the card lets it be.
const firstLine = (text) => String(text || "").split("\n").map((line) => line.trim()).find(Boolean) || "";
const clip = (text, length) => (text.length > length ? `${text.slice(0, length)}…` : text);

/**
 * Report Issue's address, from the alert card (`ViewerAlertCard`): a new issue on `issues` saying
 * what the card says. It is named for the card's title and the failure's first line; its body asks
 * what the person was doing, quotes the card — title, message, failure — and names the file (by
 * its name, never its path), the version and the platform; the card's Details close it, and are
 * what gives way when the address grows too long (`issueUrl`). "" where the host has no tracker.
 *
 * @param {string | undefined} issues `ViewerLinks.issues`.
 * @param {{ title: string, message?: string, reason?: string, details?: string }} alert
 *   The card's alert, its `title` as the card shows it.
 * @param {{ file?: string, version?: string, platform?: string }} [about]
 *   The file's path (only its name is written), the host's version and platform.
 */
export function alertIssueUrl(issues, alert, { file = "", version = "", platform = "" } = {}) {
  const reason = clip(firstLine(alert.reason), 360);
  const quote = [`**${alert.title}**`, String(alert.message || "").trim(), reason].filter(Boolean)
    .join("\n").split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
  return issueUrl(issues, {
    title: reason ? `${alert.title}: ${clip(reason, 100)}` : alert.title,
    body: `**What were you doing?**\n\n\n\n**Error**\n\n${quote}`,
    about: { File: String(file || "").split(/[\\/]/u).pop(), CAD: version, Platform: platform },
    details: String(alert.details || "")
  });
}
