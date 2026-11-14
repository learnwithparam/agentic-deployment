// Ask a list of model providers for an answer. Today it asks the first one and waits for ever.
export type Provider = { name: string; url: string };
export type Answer = { provider: string; text: string };

export async function askWithFallback(
  providers: Provider[],
  question: string,
  _timeoutMs: number,
): Promise<Answer> {
  const first = providers[0];
  const response = await fetch(first.url, { method: "POST", body: JSON.stringify({ question }) });
  const body = (await response.json()) as { text: string };
  return { provider: first.name, text: body.text };
}
