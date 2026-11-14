# Fall back when a provider stalls

## The problem

A model provider can go quiet. The call does not fail. It just never answers. Today the desk waits for ever,
the resident watches a blank page, and the run holds its slot.

For example, one provider stalls for 4 seconds on every call. A resident who waits 4 seconds for each
reply gives up. A second provider is ready, but nothing asks it.

## Your challenge

Work in `src/ask.ts`. It has one function, `askWithFallback`. It gets a list of providers, a question and a
time limit in milliseconds.

1. **Set a timeout.** Give `fetch` a `signal` made with `AbortSignal.timeout(timeoutMs)`. A call that
   takes longer is cut off and throws.
2. **Treat a bad answer like a stall.** If the provider answers with an error code, throw too.
3. **Try the next provider.** Ask the providers one at a time, in order. Keep a short reason for each one
   that failed.
4. **Give up clearly.** When every provider has failed, throw an error whose message starts with
   `model_unavailable`, and list the reasons.

```mermaid
flowchart LR
  Q[question] --> A[provider 1]
  A -->|answers in time| R[answer]
  A -->|stalls or fails| B[provider 2]
  B -->|answers in time| R
  B -->|stalls or fails| E[model_unavailable]
```

```bash
bun run verify fall-back-when-a-provider-stalls
```

Expect: `Done. All 4 rules pass.`

You do not need Docker for this step. The check starts three small fake providers on your machine.

## Done when

- A provider that stalls is given up on after the timeout, and the next one answers.
- A provider that answers with an error code is skipped.
- When no provider answers, the error starts with `model_unavailable` and comes soon.
- A healthy first provider answers alone, and the spare is never asked.

## If you get stuck

- Did the check wait for 4 seconds and then fail? The timeout is missing from `fetch`.
- Did the spare provider get a call it should not have? You asked all providers at once. Ask one at a
  time. Every extra call is paid for.
- Compare with `../solution/` when you are done.

Do it on your work: open the file where your own agent calls a model. Find the `fetch` call. Does it have a
time limit? Add one, and name your second provider.

## Words you will use

- **Timeout**: a time limit. When it ends, the call is cut off.
- **Fallback**: a second choice that is used when the first one fails.
- **Stall**: the call neither answers nor fails. It just waits.
