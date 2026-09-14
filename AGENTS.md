# AGENTS.md

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature>/` in this repo (no git remote, so no hosted tracker). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Checks

oxlint and oxfmt own linting and formatting; this repo has no ESLint or Prettier.

- `bun run check` — the full gate (type diagnostics + rules + format). Run it before yielding.
- `bun run lint:fix`, `bun run fmt` — apply the mechanical fixes.
- Never silence a rule with an inline `oxlint-disable`; turn it off in `.oxlintrc.json` with a stated reason.
- `r5f-dedi-*/` is read-only game content and deliberately excluded from both tools.

Config: `.oxlintrc.json`, `.oxfmtrc.jsonc`, `.editorconfig`. Rationale for the non-default choices: README §五.

## Dependencies

Newest versions only, but every package must be at least 24 h old: `bunfig.toml` sets `install.minimumReleaseAge = 86400`, honored by `bun install` / `bun add` / `bun update`. Upgrade with `bun update --latest`; it rewrites the ranges too, and when the newest release is younger than the window it resolves to the previous compliant version instead.
