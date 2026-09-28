// Reads a newline-delimited JSON stream from a POST route (the AI routes), calling onEvent
// for each line. Errors before the stream starts come back as the usual { error } JSON.

import { ApiClientError } from "@/lib/client/api";

export async function postNdjson<E extends { type: string }>(url: string, body: unknown, onEvent: (e: E) => void, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiClientError(0, "network", "Could not reach the server. Nothing was changed.");
  }
  if (!res.ok || !res.body) {
    const json = (await res.json().catch(() => null)) as { error?: { code: string; message: string; field?: string } } | null;
    throw new ApiClientError(res.status, json?.error?.code ?? "unknown", json?.error?.message ?? `The server returned ${res.status}.`, json?.error?.field);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as E);
    if (done) break;
  }
}
