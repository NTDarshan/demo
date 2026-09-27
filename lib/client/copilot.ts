// Browser side of the Copilot stream: POSTs to the investigate route and reads the
// newline-delimited JSON events as they arrive.

import { ApiClientError } from "@/lib/client/api";
import type { CopilotEvent, Investigation } from "@/lib/ai/recon-copilot/types";

export async function streamInvestigation(itemId: string, onEvent: (e: CopilotEvent) => void, signal?: AbortSignal): Promise<Investigation> {
  let res: Response;
  try {
    res = await fetch(`/api/ai/recon-items/${itemId}/investigate`, { method: "POST", signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiClientError(0, "network", "Could not reach the server. Nothing was changed.");
  }
  if (!res.ok || !res.body) {
    const json = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    throw new ApiClientError(res.status, json?.error?.code ?? "unknown", json?.error?.message ?? `The server returned ${res.status}.`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: Investigation | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as CopilotEvent;
      onEvent(event);
      if (event.type === "done") result = event.investigation;
      if (event.type === "error") throw new ApiClientError(502, event.code, event.message);
    }
    if (done) break;
  }
  if (!result) throw new ApiClientError(502, "ai_no_result", "The Copilot stopped before it finished. Nothing was changed; try again.");
  return result;
}
