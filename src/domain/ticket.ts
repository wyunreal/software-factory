import type { Ticket } from "./types.ts";

const CRITERIA_HEADING =
  /^(?:#{1,6}\s*)?(?:\*\*)?(acceptance criteria|criterios? de aceptaci[oó]n|definition of done|definici[oó]n de terminado)(?:\*\*)?\s*:?\s*$/i;

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/;
const HEADING = /^\s*#{1,6}\s+/;

function cleanLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Issue descriptions are Markdown. We support a heading such as
 * "## Acceptance criteria" followed by bullets or task-list items, plus an
 * inline "Acceptance criteria:" marker.
 */
export function parseAcceptanceCriteria(description: string): string[] {
  const lines = description.split(/\r?\n/);
  const criteria: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (CRITERIA_HEADING.test(trimmed)) {
      inSection = true;
      continue;
    }

    if (inSection) {
      if (HEADING.test(trimmed)) break;
      const match = BULLET.exec(line);
      if (match?.[1]) {
        const value = cleanLine(match[1]);
        if (value) criteria.push(value);
      }
    }
  }

  return dedupe(criteria);
}

export function mergeAcceptanceCriteria(
  description: string,
  checklistItems: string[],
): string[] {
  return dedupe([
    ...parseAcceptanceCriteria(description),
    ...checklistItems.map(cleanLine).filter(Boolean),
  ]);
}

export function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value.trim());
  }
  return result;
}

export function ticketPrompt(ticket: Ticket): string {
  const criteria =
    ticket.acceptanceCriteria.length > 0
      ? ticket.acceptanceCriteria.map((item) => `- ${item}`).join("\n")
      : "- No explicit acceptance criteria were provided. Derive them from the description.";

  return [
    `Ticket: ${ticket.ref}`,
    `Title: ${ticket.title}`,
    `URL: ${ticket.url}`,
    "",
    "Description:",
    ticket.description || "(empty)",
    "",
    "Acceptance criteria:",
    criteria,
  ].join("\n");
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
