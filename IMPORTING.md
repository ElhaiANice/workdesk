# Importing tasks into WorkDesk (guide for AI assistants)

Use this when the user says "import", "add these to my board", "turn this into tasks", or hands you any source: a Jira ticket or epic, an email, a Teams/Slack thread, meeting notes, a spreadsheet or CSV, a PR list, a Confluence page, a plain list.

You do not need a special importer. Read the source, work out the tasks, and create them with the WorkDesk MCP tools (`create_task`, `list_tasks`, `update_task`, `add_note`). If MCP is not available, write one Markdown file per task into the tasks folder (format below).

## The procedure

1. **Read the source fully** with whatever tool fits (Jira MCP, Outlook/Teams MCP, file read, web fetch, or the text the user pasted). Do not guess at content you did not read.
2. **Decide what is a task.** One task per thing the user must do, review, follow up on, or track. Do not make a task per sentence. A long source usually gives a handful of tasks, not dozens. If the source is huge or ambiguous, list the proposed tasks in chat and ask before creating more than about 10.
3. **Check for duplicates first.** Call `list_tasks` with `query` set to the Jira key, PR number, or a distinctive title word, and with `include_done: true`. If it already exists, `update_task` or `add_note` instead of creating another. Jira keys are unique per task (`jira` field).
4. **Create each task** with `create_task` (fields below). New tasks are placed at the bottom of their column automatically; the user drags them to prioritise. Never set the order yourself.
5. **Report back**: how many created, how many skipped as duplicates, and anything you were unsure about (guessed type, missing owner).

## Fields

Only `title` is required.

| Field | Meaning | Notes |
|---|---|---|
| `title` | One line, starts with a verb when possible | "Review PR 412 for Dana", "Validate ECS deploy". Not the whole email subject chain |
| `type` | `epic`, `story`, `tech`, `bug`, `review`, `security`, `incident`, `research`, `docs`, `planning`, `follow-up`, `meeting` | If omitted it is guessed from the title. Set it yourself when you know |
| `status` | `inbox` (shown as **Pending**), `todo`, `in-progress`, `waiting`, `review`, `done` | Default is Pending. Use `done` only for work the source says is finished |
| `jira` | Jira key, e.g. `ABC-2481` | Set it whenever the source has one. Also set `url` to the ticket link |
| `url` | Link to the original item | Ticket, thread, document |
| `epic` | Jira key (or task id) of the parent epic | Only for stories/bugs under an epic |
| `epic_title`, `epic_owner`, `reporter` | Context from Jira | Optional |
| `who` | The person involved | `waiting`: who you wait on. `review`: the author. `meeting`: attendees. A `waiting` task should always have `who` |
| `pr` | Pull request URL | Review and story tasks |
| `repos` | Array like `["BE/media-utils"]` | Folders under the workspace |
| `env` | Environment | e.g. `staging`, `prod` |
| `important` | `true` to red-flag | Only when the user or the source says it is urgent/blocking. Do not flag by default |
| `tags` | Array of short labels | Optional, use sparingly |
| `body` | Markdown notes | See below |

`created` is set to today automatically. There are no due dates by design: if the source has a deadline, put it in the body text.

## Body (notes)

Put detail here, not in the title:

- A short context paragraph: what and why, in your own words.
- A checklist of concrete steps, one per line as `- [ ] step`. The board shows these and the user can tick them.
- The source reference, e.g. `Source: email from Dana, 2026-10-20` or the thread link.

Do not write `<!-- jira -->` blocks. That section is owned by Jira sync, which rewrites it.

## Choosing type and status

- Someone asked you to look at their PR: `review`, with `who` and `pr`.
- You promised or someone owes you something: `follow-up`; if you are blocked on them, `waiting` plus `who`.
- A call or meeting you must prepare for or act on: `meeting`, attendees in `who`, actions as checklist.
- A Jira epic: `epic`; its stories: `story` with `epic` set to the epic key.
- A defect: `bug`. A vulnerability or CVE: `security`. A production issue: `incident`.
- Unsure: use `follow-up` and `status` Pending, and say so in your report.

## Jira sources

The app has its own Jira sync (Settings or the Jira page: "Sync my tickets", "Import epic with its stories"). If the user only wants their Jira tickets in the board, point them to that rather than copying by hand. When you import Jira items yourself (for example from a query the sync does not cover), use the Jira MCP to read them, then `create_task` with `jira`, `url`, `epic`, `jira_status`, and a status mapped from the Jira status:

| Jira status says | WorkDesk status |
|---|---|
| to do, open, backlog | `todo` |
| in progress | `in-progress` |
| in review, code review | `review` |
| blocked, on hold, pending | `waiting` (add `who`, or leave it `todo` if nobody is named) |
| done, closed, resolved | `done` |

## Spreadsheet / CSV / list sources

One row or line becomes one task. Map columns to fields by their meaning (title, owner to `who`, link to `url`, status to `status`). Keep unmapped columns as lines in the body ("Priority: High"). Skip empty rows and header repeats.

## Writing files directly (no MCP)

One file per task in the tasks folder (`tasks/` next to the app, or the folder in `WORKDESK_TASKS`). File name is the id: lowercase, words joined by `-`, ending in `.md` (for example `abc-2481-cwe-78-remediation.md`). Do not overwrite an existing file.

```
---
type: story
title: CWE-78 remediation
status: todo
jira: ABC-2481
epic: ABC-2400
created: 2026-10-26
order: 41
---
Why this matters in one or two sentences.
- [ ] first step
- [ ] second step
```

Rules: front-matter between two `---` lines, `key: value`, arrays as `[a, b]`, dates as `YYYY-MM-DD`. For `order`, use a number higher than every existing task's order so the task lands at the bottom (look at the highest `order` in the folder and add 1). The running app picks new files up by itself.

## Do not

- Do not invent tickets, people, links or dates the source does not contain.
- Do not mark things `done`, `important` or `waiting` on a hunch.
- Do not delete or overwrite existing tasks as part of an import.
- Do not paste secrets or tokens from the source into notes.
