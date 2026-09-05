# Coffee Bond Codex Bootstrap

**THIS IS AN EXISTING PRODUCTION SYSTEM.** Before Coffee Bond work:

1. Read `docs/coffee-bond-ai/README.md`.
2. Read `docs/coffee-bond-ai/knowledge/CURRENT_PRODUCTION_STATE.md`.
3. Read `docs/coffee-bond-ai/CURRENT_HANDOFF.md`.
4. Confirm `pwd`, branch, HEAD, status, and `git diff --check`.
5. Continue from verified state; preserve uncommitted work.
6. Do not redesign or reimplement a feature unless the current implementation proves a limitation.
7. Maintenance scripts default to a demo project + emulator + no ADC; a real project needs an explicit `--allow-production --confirm-project=<id>`.
8. When another agent may be running: use isolated emulator project ids and ports, inspect occupied ports first, never kill a process you did not start, and keep one worktree per agent.
9. Report `SKILL_USED` / `SKILL_PATHS` / `SKILL_COMPLIANCE` at handoff.
