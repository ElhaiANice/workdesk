'use strict';
// WorkDesk MCP server (stdio, newline-delimited JSON-RPC 2.0). Zero dependencies.
// Reads and writes the same Markdown task files as the web app, so the UI updates live.
require('../lib/env');
const readline = require('readline');
const tasks = require('../lib/tasks');

const STATUS_ENUM = tasks.STATUSES, TYPE_ENUM = tasks.TYPES;
const fieldProps = {
  type: { type: 'string', enum: TYPE_ENUM }, status: { type: 'string', enum: STATUS_ENUM },
  order: { type: 'number', description: 'Sort position; leave unset, new tasks go to the bottom' }, jira: { type: 'string' }, epic: { type: 'string', description: 'Jira key of the parent epic' }, epic_owner: { type: 'string' },
  repos: { type: 'array', items: { type: 'string' } }, who: { type: 'string' }, important: { type: 'boolean', description: 'Red-flag this task as important' },
  pr: { type: 'string' }, url: { type: 'string' }, jira_status: { type: 'string' }, reporter: { type: 'string' }, epic_title: { type: 'string' }, env: { type: 'string' },
  tags: { type: 'array', items: { type: 'string' } }, body: { type: 'string', description: 'Markdown notes; "- [ ] item" lines form the checklist' },
};
const id = { type: 'string', description: 'Task id (file name without .md) or Jira key' };

const TOOLS = [
  { name: 'list_tasks', description: 'List WorkDesk tasks (summary rows). Filter by status, type, epic or free-text query. Done tasks are excluded unless status=done or include_done=true.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: STATUS_ENUM }, type: { type: 'string', enum: TYPE_ENUM }, epic: { type: 'string' }, query: { type: 'string' }, include_done: { type: 'boolean' } } },
    run: (a) => {
      const q = (a.query || '').toLowerCase();
      return tasks.list().filter((t) => (a.status ? t.status === a.status : a.include_done || t.status !== 'done') && (!a.type || t.type === a.type) && (!a.epic || (t.epic || '').toUpperCase() === a.epic.toUpperCase()) && (!q || [t.title, t.jira, t.who, t.body].join(' ').toLowerCase().includes(q)))
        .sort((x, y) => (Number(x.order) || 0) - (Number(y.order) || 0) || x.title.localeCompare(y.title)).map(({ body, ...t }) => t);
    } },
  { name: 'get_task', description: 'Get one task in full (all fields and Markdown notes).', inputSchema: { type: 'object', properties: { id }, required: ['id'] }, run: (a) => tasks.find(a.id) },
  { name: 'create_task', description: 'Create a task. Only title is required (type defaults to follow-up, status to inbox, shown as Pending).',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, ...fieldProps }, required: ['title'] }, run: (a) => tasks.create(a) },
  { name: 'update_task', description: 'Update fields of a task. Pass only fields to change; an empty string clears a field. A "waiting" task should have who.',
    inputSchema: { type: 'object', properties: { id, title: { type: 'string' }, ...fieldProps }, required: ['id'] }, run: ({ id: tid, ...patch }) => tasks.update(tasks.find(tid).id, patch) },
  { name: 'add_note', description: 'Append a line or paragraph to the task notes (use for progress, findings, links).',
    inputSchema: { type: 'object', properties: { id, text: { type: 'string' } }, required: ['id', 'text'] },
    run: (a) => { const t = tasks.find(a.id); return tasks.update(t.id, { body: t.body.replace(/\s*$/, '') + '\n\n' + a.text + '\n' }); } },
  { name: 'check_item', description: 'Tick or untick a checklist item by its 0-based index in the task notes.',
    inputSchema: { type: 'object', properties: { id, index: { type: 'integer', minimum: 0 }, checked: { type: 'boolean' } }, required: ['id', 'index'] },
    run: (a) => tasks.setCheck(tasks.find(a.id).id, a.index, a.checked !== false) },
  { name: 'delete_task', description: 'Permanently delete a task file. Only on explicit user request.', inputSchema: { type: 'object', properties: { id }, required: ['id'] },
    run: (a) => { const t = tasks.find(a.id); tasks.remove(t.id); return { deleted: t.id }; } },
];

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

function handle(msg) {
  const { id: rid, method, params } = msg;
  const reply = (result) => rid !== undefined && send({ id: rid, result });
  const error = (code, message) => rid !== undefined && send({ id: rid, error: { code, message } });
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'workdesk', version: '1.0.0' },
        instructions: `WorkDesk is the user's personal task list (epics, stories, tech tasks, reviews, follow-ups). Tasks live in ${tasks.DIR}. Update status and notes as you work so the board stays accurate. To import tasks from any other source (Jira, email, a spreadsheet, meeting notes, a list), read IMPORTING.md in the WorkDesk folder first.` });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return error(-32602, 'Unknown tool: ' + params?.name);
      try {
        return reply({ content: [{ type: 'text', text: JSON.stringify(tool.run(params.arguments || {}), null, 2) }] });
      } catch (e) {
        return reply({ isError: true, content: [{ type: 'text', text: e.message }] });
      }
    }
    default:
      if (method && method.startsWith('notifications/')) return;
      return error(-32601, 'Method not found: ' + method);
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  try { handle(msg); } catch (e) { send({ id: msg.id ?? null, error: { code: -32603, message: e.message } }); }
});
