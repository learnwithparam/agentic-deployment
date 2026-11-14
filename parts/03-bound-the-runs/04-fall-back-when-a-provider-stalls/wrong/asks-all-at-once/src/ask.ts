// Wrong: it asks every provider at once, so every run is paid for twice.
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
  try {
    return await Promise.any(providers.map((provider) => askOne(provider, question, timeoutMs)));
  } catch {
    throw new Error("model_unavailable: no provider answered");
  }
}
