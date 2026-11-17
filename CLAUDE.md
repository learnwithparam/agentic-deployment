# Agent notes for agentic-deployment

Claude Code reads this file first. Follow these rules for every learner page, doc, code comment and screen string.

## Plain English (the teach repo standard)

- Reading grade 6 or lower for each page with 5 or more sentences.
- Each sentence has 25 words or fewer. Learner step pages average 15 words or fewer.
- A paragraph has 5 sentences or fewer.
- One idea per sentence. Use the everyday word. Name a hard term once, with its meaning right after it.
- Use active voice. Say what the learner sees, then what to do.
- Headings start with a verb for steps and parts. Use sentence case. No full stop. No counts such as "Lab 3" or "39 steps".
- Banned headings: Introduction, Overview, Background, Notes, Misc, Details, More.
- No em dashes. No semicolons in prose. No hype words.
- Teaching pages contain the phrase "For example".
- Link text never says "here", "click here" or "this link".
- Do not say "above" or "below" for parts of a page.
- Every `bash` block is followed by an `Expect:` line that shows the result.
- Backticks are only for commands and code the learner types, never for plain English.

## Never change these when you rewrite prose

- Code blocks, tables, Mermaid diagrams, image links and `Expect:` lines stay word for word.
- Troubleshooting pages: keep the left column (the exact messages a check prints) byte for byte.
- `scripts/learner-clarity.mjs` stays identical to the teach repo copy. Do not edit it here.

## Checks to run before you say a page is done

1. `bun run format`
2. `bun run check` must exit 0.
3. `python3 /Users/param/learn/learnwithparam/rewrite-tools/verify-page.py . <rel-path>` for each page you changed.

## Working rules

- Read a page before you change it. Rewrite a page in one write, then verify it.
- Finish a whole repo before you start the next. Do not leave a repo half done.
