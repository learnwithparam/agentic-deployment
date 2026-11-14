// Ask a list of model providers for an answer. A provider that stalls or fails is skipped.
export type Provider = { name: string; url: string };
export type Answer = { provider: string; text: string };

async function askOne(provider: Provider, question: string, timeoutMs: number): Promise<Answer> {
  const response = await fetch(provider.url, {
    method: "POST",
    body: JSON.stringify({ question }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${provider.name} answered ${response.status}`);
  const body = (await response.json()) as { text: string };
  return { provider: provider.name, text: body.text };
}

export async function askWithFallback(
  providers: Provider[],
  question: string,
  timeoutMs: number,
): Promise<Answer> {
  const reasons: string[] = [];
  for (const provider of providers) {
    try {
      return await askOne(provider, question, timeoutMs);
    } catch (error) {
      reasons.push(`${provider.name}: ${(error as Error).message}`);
    }
  }
  throw new Error(`model_unavailable: ${reasons.join("; ")}`);
}
