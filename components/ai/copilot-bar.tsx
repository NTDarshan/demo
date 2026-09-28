"use client";

// "Investigate all": runs the Copilot on every open exception that has no suggestion yet,
// one after another, so the accountant comes back to a queue of ready suggestions.

import { Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ApiClientError } from "@/lib/client/api";
import { streamInvestigation } from "@/lib/client/copilot";

export function CopilotBar({ openCount, readyCount, pending }: { openCount: number; readyCount: number; pending: { id: string; gatewayRef: string }[] }) {
  const router = useRouter();
  const toast = useToast();
  const [progress, setProgress] = useState<{ done: number; current: string; step: string } | null>(null);

  async function runAll() {
    let done = 0;
    let failed = 0;
    for (const item of pending) {
      setProgress({ done, current: item.gatewayRef, step: "Starting" });
      try {
        await streamInvestigation(item.id, (e) => {
          if (e.type === "step") setProgress({ done, current: item.gatewayRef, step: e.label });
        });
      } catch (err) {
        failed += 1;
        if (err instanceof ApiClientError && err.code === "ai_unavailable") break;
      }
      done += 1;
    }
    setProgress(null);
    router.refresh();
    if (failed) toast.error(`${failed} investigation${failed === 1 ? "" : "s"} failed`, "Open the item and try again.");
    else toast.success("Suggestions ready", `${done} exception${done === 1 ? "" : "s"} investigated. Review each one before accepting.`);
  }

  if (openCount === 0) return null;
  return (
    <div className="flex flex-col gap-3 rounded-panel border border-accent/25 bg-accent/5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex gap-3">
        <Sparkles className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
        <div>
          <p className="font-medium">Reconciliation Copilot</p>
          {progress ? (
            <p className="text-sm text-muted" aria-live="polite">
              Investigating {progress.done + 1} of {pending.length}: <span className="font-mono">{progress.current}</span> · {progress.step}
            </p>
          ) : (
            <p className="text-sm text-muted">
              {readyCount > 0 ? `${readyCount} of ${openCount} open exception${openCount === 1 ? " has" : "s have"} a suggestion ready. ` : ""}
              It checks the gateway, the student&apos;s account and the file, then suggests a resolution. You decide.
            </p>
          )}
        </div>
      </div>
      {pending.length > 0 ? (
        <Button onClick={() => void runAll()} disabled={progress !== null} className="shrink-0">
          {progress ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
          {progress ? "Investigating" : `Investigate ${pending.length === openCount ? "all" : "the rest"} (${pending.length})`}
        </Button>
      ) : null}
    </div>
  );
}
