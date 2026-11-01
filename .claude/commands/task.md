---
description: Work on a WorkDesk task (by id or Jira key), keeping the board up to date
argument-hint: <task id or Jira key, e.g. ABC-2481>
---

Work on WorkDesk task: $ARGUMENTS

1. Call the `workdesk` MCP tool `get_task` with that id/key. If it is missing, call `list_tasks` with `query` and ask which one the user means.
2. Read its notes and checklist. If `repos` is set, work in those repos under your workspace folder (Settings > Workspace folder). If that workspace has its own CLAUDE.md or AGENTS.md, read and follow it before any repo work.
2b. The task body starts with a "From Jira" block (description, reporter, link). Treat it as the source of truth for requirements; do not edit it.
3. Call `update_task` to set `status` to `in-progress`.
4. Do the work. After each checklist step finishes, call `check_item`. Record findings, decisions and links with `add_note`.
5. If you are blocked on a person, set `status` to `waiting` with `who` and explain in a note.
6. When the work is ready for review set `status` to `review`. Only set `done` if the user confirms.
7. End with a short summary: what changed, what is left, and the task's final status.

By task type:
- epic: read the description, propose a breakdown into stories/tasks, record it as a checklist in the notes.
- story: implement it in the listed repos following the repo conventions; add tests.
- tech: run the validation/deployment/manifest work and note the evidence (commands, results).
- review: review the PR in `pr` and add findings to the notes.
- follow-up / meeting: help prepare (agenda, summary, message draft); do not send anything.

Do not delete tasks and do not write to Jira.
