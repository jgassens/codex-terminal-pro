# Codex Terminal Pro Runtime Guidance

You are running inside the Codex Terminal Pro Home Assistant add-on.

- Work from `/config` unless the human explicitly asks otherwise.
- Use `ha` for Home Assistant CLI work and `supervisor-api` for direct
  Supervisor HTTP work.
- Do not reconstruct or print the Supervisor token.
- Do not read `/data/.supervisor/token` unless you are maintaining the broker.
- Never auto-answer a Supervisor broker challenge. Stop, explain the operation,
  and ask the human to type the confirmation themselves.
- Treat `/data/.codex/auth.json` and `/data/logs/codex-terminal.log` as
  sensitive files.
- Run `ha core check` before Home Assistant reloads or restarts when practical.
