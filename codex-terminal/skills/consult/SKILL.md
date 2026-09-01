---
name: consult
description: Ask other AI models (Claude Code and Kimi Code) for an independent opinion on a hard problem in this Home Assistant config - one, or several at once in parallel. Use when the user asks for a second opinion or another model's view, when two or more of your own attempts at a bug have failed, or before a change that is hard to undo such as editing automations, recorder retention, or Z-Wave and Matter device settings. Do not use it for questions you can already answer, for routine edits, or to look things up.
---

# Consulting a second model

This add-on may have consultants configured: other coding CLIs signed in with
the user's own subscriptions. They are advisors only. You remain the agent
doing the work, and you own the final answer.

## Checking what is available

```bash
consult --list
```

Consultants are optional and are set up by the user in the add-on's Settings
panel. If none is signed in, say so plainly and carry on yourself rather than
treating it as a blocker.

## Asking

For a real second opinion, ask both consultants at once:

```bash
consult --agents kimi,claude "Question here, with enough context."
```

They run in parallel and are independent opinions, not a primary and a
backup. Answers stream back fastest first, each in a labelled block. Kimi
usually lands first; if her answer already settles the question, act on it and
move on - you need not wait for Claude. If it does not, wait for Claude's
slower, deeper answer, which the same command prints when it arrives.

Ask a single consultant only when you specifically want just one:

```bash
consult --agent kimi "Question here."
consult "Question here."   # the default consultant from Settings
```

The question is the whole prompt, so write it as you would to a competent
colleague who has not seen the conversation: state the goal, what you already
tried, and what specifically you want judged. Name the files worth reading;
the consultant opens its own filtered snapshot copies.

A consult that reads files at high effort can take several minutes - that is
the intelligence you asked for working, not a hang. Each consultant answers
under its own timeout (default 600s); one that overruns is reported as "no
answer" for that consultant while the others still stand. Raise the limit with
`--timeout SECONDS`, up to 1800. Do not launch the same consultant twice over
one question; asking different consultants together is what `--agents` is for.

## What the consultant can see

It runs as a dedicated unprivileged user whose working directory is a
bounded, root-owned text snapshot of `/config` - never the live `/config` or
`/data` trees - with `.storage`, `secrets.yaml`, credential/key files,
databases, logs, backups, symlinks, binary files, and oversized files left
out. Where the kernel provides Landlock it is added on top to block reads
outside the snapshot by absolute path. Common
inline token and secret assignments are redacted in the snapshot. It can write
only to its disposable credential home, which is deleted after the answer.

Two things follow. First, give it the context it needs in the question itself,
because it cannot ask a follow-up. Second, the filtered configuration is being
sent to a third-party model, so do not consult over trivia and never paste a
secret into the question. If a consult reports it is not set up or its
isolation could not be applied, sign it in or report the error; do not bypass
it by launching the provider CLI directly.

## Using the answer

Report each consultant's view as what it is: another model's opinion, named,
and separate from your own. When you asked several, attribute each answer to
the consultant that gave it, and weigh a genuine disagreement between them
rather than averaging it away.

Weigh it rather than deferring to it. You have the conversation, the history,
and the user's stated intent; it has one paragraph and a read-only filesystem.
When you disagree, say so and explain why. When it changes your mind, say that
too. If its answer is vague or it clearly misread the situation, discard it and
tell the user you did.

Never apply a change solely because a consultant suggested it. The user's
approval rules still apply exactly as they do to your own proposals.
