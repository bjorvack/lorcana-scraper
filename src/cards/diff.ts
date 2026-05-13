/**
 * Diff two `CardSet`s and render a human-reviewable Markdown report.
 *
 * Classifies each card id as added / removed / changed (any field other than
 * `id` differs after canonical JSON serialisation). Stable ordering by id.
 */
import type { CardSetT, CardT } from "@bjorvack/lorcana-schemas";

export interface CardsDiff {
  readonly added: CardT[];
  readonly removed: CardT[];
  readonly changed: { readonly before: CardT; readonly after: CardT }[];
}

export function diffCardSets(prior: CardSetT | null, next: CardSetT): CardsDiff {
  const priorMap = new Map<string, CardT>();
  for (const c of prior?.cards ?? []) priorMap.set(c.id, c);
  const nextMap = new Map<string, CardT>();
  for (const c of next.cards) nextMap.set(c.id, c);

  const added: CardT[] = [];
  const removed: CardT[] = [];
  const changed: { before: CardT; after: CardT }[] = [];

  for (const [id, after] of nextMap) {
    const before = priorMap.get(id);
    if (!before) added.push(after);
    else if (!sameContent(before, after)) changed.push({ before, after });
  }
  for (const [id, before] of priorMap) {
    if (!nextMap.has(id)) removed.push(before);
  }

  const byId = (a: CardT, b: CardT) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    added: added.sort(byId),
    removed: removed.sort(byId),
    changed: changed.sort((a, b) => byId(a.after, b.after)),
  };
}

export function isEmpty(d: CardsDiff): boolean {
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
}

export function renderDiffMarkdown(d: CardsDiff, opts: { priorTag: string | null }): string {
  const lines: string[] = [];
  lines.push(`# Cards diff`);
  lines.push("");
  lines.push(`Compared against: \`${opts.priorTag ?? "(no prior release)"}\``);
  lines.push("");
  lines.push(
    `Added: **${d.added.length}** · Removed: **${d.removed.length}** · Changed: **${d.changed.length}**`,
  );
  lines.push("");

  if (d.added.length) {
    lines.push("## Added");
    lines.push("");
    for (const c of d.added) lines.push(`- \`${c.id}\` — ${displayName(c)} (${c.setCode})`);
    lines.push("");
  }
  if (d.removed.length) {
    lines.push("## Removed");
    lines.push("");
    for (const c of d.removed) lines.push(`- \`${c.id}\` — ${displayName(c)} (${c.setCode})`);
    lines.push("");
  }
  if (d.changed.length) {
    lines.push("## Changed");
    lines.push("");
    for (const { before, after } of d.changed) {
      const fields = diffFields(before, after);
      lines.push(
        `- \`${after.id}\` — ${displayName(after)} (${after.setCode}): ${fields.join(", ")}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function displayName(c: CardT): string {
  return c.version ? `${c.name} — ${c.version}` : c.name;
}

function sameContent(a: CardT, b: CardT): boolean {
  return canonical(a) === canonical(b);
}

function canonical(c: CardT): string {
  // Stable JSON: sort object keys recursively.
  return JSON.stringify(c, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.keys(v as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = (v as Record<string, unknown>)[k];
            return acc;
          }, {})
      : v,
  );
}

function diffFields(before: CardT, after: CardT): string[] {
  const fields: string[] = [];
  for (const k of Object.keys(after) as (keyof CardT)[]) {
    if (canonical({ ...before, [k]: after[k] } as CardT) === canonical(after)) continue;
    if (canonical({ ...after, [k]: before[k] } as CardT) === canonical(before)) {
      fields.push(String(k));
    }
  }
  // Simpler fallback: list every field whose JSON differs.
  if (fields.length === 0) {
    for (const k of Object.keys(after) as (keyof CardT)[]) {
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) fields.push(String(k));
    }
  }
  return fields;
}
