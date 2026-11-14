// Wrong: it has a timeout, but it retries the same provider and never moves on.
export type Provider = { name: string; url: string };
export type Answer = { provider: string; text: string };

export async function askWithFallback(
  providers: Provider[],
  question: string,
  timeoutMs: number,
): Promise<Answer> {
  const first = providers[0];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(first.url, {
        method: "POST",
        body: JSON.stringify({ question }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;
      const body = (await response.json()) as { text: string };
      return { provider: first.name, text: body.text };
    } catch {}
  }
  throw new Error("model_unavailable: the first provider did not answer");
}
