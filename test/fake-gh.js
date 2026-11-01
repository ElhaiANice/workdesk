// Stand-in for `gh pr view <url> --json ...`: the state comes from the PR number in the URL.
const n = +(/pull\/(\d+)/.exec(process.argv[4]) || [])[1];
const out = { 1: { state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED' }, 2: { state: 'MERGED', isDraft: false, reviewDecision: '' }, 3: { state: 'OPEN', isDraft: true, reviewDecision: '' } }[n];
if (!out) { console.error('gh: not found'); process.exit(1); }
console.log(JSON.stringify(out));
