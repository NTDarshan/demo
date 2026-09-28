// Evidence: every record an AI tool returned, so the verifier can check what the model says
// against it and the UI can link each claim to the page it came from. Shared by the
// Reconciliation Copilot and Ask Kosha.

import { formatDateTime } from "@/lib/dates";
import { formatINR } from "@/lib/money";

export type EvidenceKind = "item" | "payment" | "gateway" | "student" | "file" | "run" | "check" | "report";

export type EvidenceItem = {
  id: string;
  kind: EvidenceKind;
  label: string;
  /** Link in the app, when there is a page for it. */
  href: string | null;
};

/** Everything the tools returned, so the verifier can check what the model says against it. */
export class EvidenceBag {
  private readonly items = new Map<string, EvidenceItem>();
  private readonly amounts = new Set<number>();
  duplicateSuspected = false;

  add(item: EvidenceItem, amountsPaise: (number | null | undefined)[] = []): string {
    if (!this.items.has(item.id)) this.items.set(item.id, item);
    for (const a of amountsPaise) this.addAmount(a);
    return item.id;
  }

  addAmount(paise: number | null | undefined) {
    if (typeof paise === "number" && Number.isSafeInteger(paise)) this.amounts.add(Math.abs(paise));
  }

  get ids(): ReadonlySet<string> {
    return new Set(this.items.keys());
  }

  get knownAmounts(): ReadonlySet<number> {
    return this.amounts;
  }

  list(): EvidenceItem[] {
    return [...this.items.values()];
  }
}

export const inr = (paise: number | null | undefined) => (paise === null || paise === undefined ? null : formatINR(paise, { paise: "auto" }));
export const when = (iso: string | null | undefined) => (iso ? formatDateTime(iso) : null);
