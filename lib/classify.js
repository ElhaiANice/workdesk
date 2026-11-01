'use strict';
// Auto-choose a task type from its title. First matching rule wins; the UI offers a quick menu to change it.
// The same rules are sent to the browser (/api/config) so the live preview and the server always agree.
const RULES = [
  ['epic', '\\bepic\\b'],
  ['review', '\\b(review\\w*|pull request|prs?)\\b'],
  ['meeting', '\\b(meeting|meet|sync|1:1|stand-?up|retro\\w*|demo|workshop|kick-?off|call)\\b'],
  ['incident', '\\b(incident|outage|sev-?\\d|on-?call|rca|post-?mortem|degrad\\w*)\\b'],
  ['security', '\\b(cve|cwe|vuln\\w*|security|xss|csrf|owasp|pen-?test|sonar\\w*|secrets?)\\b'],
  ['bug', '\\b(bugs?|fix(es|ed)?|defects?|regression|hotfix|crash\\w*|broken|exception)\\b'],
  ['research', '\\b(research|investigat\\w*|poc|spike|explore|evaluat\\w*|compare)\\b'],
  ['docs', '\\b(docs?|documentation|readme|wiki|runbook|confluence|write-?up|presentation|slides?)\\b'],
  ['planning', '\\b(plan\\w*|estimat\\w*|design|architecture|refine\\w*|roadmap|proposal)\\b'],
  ['tech', '\\b(deploy\\w*|validat\\w*|manifests?|helm|config\\w*|pipelines?|rollout|infra\\w*|terraform|k8s|migrat\\w*|upgrade|refactor\\w*|cleanup)'],
  ['story', '\\b(story|implement\\w*|feature)\\b|\\b[a-z]+-\\d+\\b'],
];
const COMPILED = RULES.map(([t, src]) => [t, new RegExp(src, 'i')]);

const classify = (title) => (COMPILED.find(([, re]) => re.test(String(title || ''))) || ['follow-up'])[0];

module.exports = { RULES, classify };
