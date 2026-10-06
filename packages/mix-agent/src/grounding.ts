/**
 * Hallucination guard for replies. Every dB, Hz, %, ms, LUFS, or ratio in a reply must appear in something the
 * agent actually saw this turn (the context, a tool result, or the person's words), and a reply may not claim a
 * write (applied, undone, set) that did not happen. It is a check on numbers and claims, not on meaning; the tools'
 * allowlist and value checks are what keep invented values out of the mix itself.
 */

const UNIT_NUMBER = /([+\-−]?\d+(?:[.,]\d+)?)\s?(dbfs|db|lufs|khz|hz|%|ms|:1)(?![a-z])/gi;
const ANY_NUMBER = /-?\d+(?:\.\d+)?/g;

export interface GroundingCheck {
  unsupported: string[];
  falseWrites: string[];
}

function ledger(facts: readonly string[]): number[] {
  const values = new Set<number>();
  for (const fact of facts) {
    for (const match of fact.matchAll(ANY_NUMBER)) {
      const value = Math.abs(Number(match[0]));
      if (!Number.isFinite(value)) continue;
      values.add(value);
      // The same quantity written another way: kHz and Hz, a fraction and a percent.
      values.add(value * 1000);
      values.add(value / 1000);
      values.add(value * 100);
      values.add(value / 100);
    }
  }
  return [...values];
}

function supported(value: number, known: number[]): boolean {
  const tolerance = Math.max(0.06, Math.abs(value) * 0.025);
  return known.some((item) => Math.abs(item - value) <= tolerance);
}

const WRITE_CLAIMS: Array<{ kind: "apply" | "undo" | "edit"; pattern: RegExp }> = [
  { kind: "apply", pattern: /\b(i(?:'ve| have)? applied|i(?:'ve| have) written|(?:has|have) been applied|(?:is|are) now applied|applied (?:the|those|these|it|\d+|your)\b|now part of (?:the|your) (?:saved )?mix)/i },
  { kind: "undo", pattern: /\b(i(?:'ve| have)? (?:undone|undid|reverted)|(?:has|have) been (?:undone|reverted))\b/i },
  { kind: "edit", pattern: /\b(i(?:'ve| have)? (?:set|moved|panned|lowered|raised|turned) (?:the )?[a-z0-9 ]{1,30} (?:to|by|down|up))\b/i },
];

export function checkGrounding(message: string, facts: readonly string[], writes: ReadonlyArray<{ kind: "apply" | "undo" | "edit" }>): GroundingCheck {
  const known = ledger(facts);
  const unsupported: string[] = [];
  for (const match of message.matchAll(UNIT_NUMBER)) {
    const value = Math.abs(Number(match[1]!.replace("−", "-").replace(",", ".")));
    if (!Number.isFinite(value) || value === 0) continue;
    if (!supported(value, known)) unsupported.push(match[0]!.trim());
  }
  const falseWrites: string[] = [];
  for (const claim of WRITE_CLAIMS) {
    const found = claim.pattern.exec(message);
    if (found && !writes.some((write) => write.kind === claim.kind || (claim.kind === "edit" && write.kind === "apply"))) falseWrites.push(found[0]!);
  }
  return { unsupported: [...new Set(unsupported)], falseWrites };
}
