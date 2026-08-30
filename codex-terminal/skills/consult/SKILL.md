---
name: consult
description: Ask a second AI model (Claude Code or Kimi Code) for an independent opinion on a hard problem in this Home Assistant config. Use when the user asks for a second opinion or another model's view, when two or more of your own attempts at a bug have failed, or before a change that is hard to undo such as editing automations, recorder retention, or Z-Wave and Matter device settings. Do not use it for questions you can already answer, for routine edits, or to look things up.
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

```bash
consult "Question here, with enough context to answer it."
consult --agent kimi "Question here."
```

The question is the whole prompt, so write it as you would to a competent
colleague who has not seen the conversation: state the goal, what you already
tried, and what specifically you want judged. Name the files worth reading;
the consultant can open them itself.

A consult usually takes one to three minutes, because the consultant is
reading files before it answers. That is longer than a normal command, so
expect to wait rather than assuming it has hung. If your own command timeout
fires first, the consult is still running: wait for it to finish instead of
starting a second one, which would only pay the cost twice.

Use `--timeout SECONDS` to allow longer than the configured default, up to
1800.

## What the consultant can see

It runs as an unprivileged user with **read-only access to `/config`**. It can
read the Home Assistant configuration to answer, and cannot modify anything.
It does not see your conversation with the user, your session history, or any
credential file.

Three things follow. First, give it the context it needs in the question
itself, because it cannot ask a follow-up. Second, the user's configuration is
being sent to a third-party model, so do not consult over trivia, and do not
paste secrets into the question. Third, `/config` can hold real credentials,
such as `secrets.yaml` and tokens under `.storage`, and a consultant may read
them while answering. Point it at the files the question needs rather than
inviting a broad search, and if a consultant reports having seen a credential,
tell the user plainly instead of burying it.

## Using the answer

Report the consultant's view as what it is: another model's opinion, named,
and separate from your own. Say which consultant answered.

Weigh it rather than deferring to it. You have the conversation, the history,
and the user's stated intent; it has one paragraph and a read-only filesystem.
When you disagree, say so and explain why. When it changes your mind, say that
too. If its answer is vague or it clearly misread the situation, discard it and
tell the user you did.

Never apply a change solely because a consultant suggested it. The user's
approval rules still apply exactly as they do to your own proposals.
