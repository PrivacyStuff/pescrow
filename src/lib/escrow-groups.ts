import type { EscrowView } from "./escrow-account.ts";

const HISTORY = new Set(["Void", "Exchanged", "Reclaimed"]);

export type EscrowGroups = {
  readonly issued: readonly EscrowView[];
  readonly received: readonly EscrowView[];
  readonly history: readonly EscrowView[];
};

export function groupEscrows(views: readonly EscrowView[]): EscrowGroups {
  const issued: EscrowView[] = [];
  const received: EscrowView[] = [];
  const history: EscrowView[] = [];
  for (const view of views) {
    if (view.status === "Proposed") {
      if (view.role === "a") issued.push(view);
      else received.push(view);
      continue;
    }
    if (HISTORY.has(view.status)) history.push(view);
  }
  return { issued, received, history };
}
