#!/usr/bin/env node
// List your Linear projects so you can grab a `slugId` for
// `examples/linear/WORKFLOW.md`. Read-only — only fetches names
// and slugs, never modifies anything.
//
// Run from the repo root:
//   node --env-file=.env scripts/list-linear-projects.mjs
//
// Or, if you have the daemon built:
//   pnpm symphony --print-projects   <-- not implemented; use this script
//
// The script uses the same auth header convention as our LinearClient
// (raw token, no `Bearer `). If this works but the daemon doesn't,
// the bug is in the daemon. If neither works, your token is wrong.

const apiKey = process.env.LINEAR_API_KEY;
if (!apiKey) {
  console.error('ERROR: LINEAR_API_KEY is not set.');
  console.error('       Make sure `.env` at the repo root contains it');
  console.error('       and you ran with `node --env-file=.env ...`.');
  process.exit(1);
}

const QUERY = `
  query ListProjects {
    projects(first: 50) {
      nodes {
        id
        name
        slugId
        state
        teams { nodes { key name } }
      }
    }
  }
`;

const res = await fetch('https://api.linear.app/graphql', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: apiKey,
  },
  body: JSON.stringify({ query: QUERY }),
});

if (!res.ok) {
  console.error(`ERROR: Linear API returned ${res.status}`);
  console.error(await res.text());
  process.exit(2);
}

const body = await res.json();
if (body.errors) {
  console.error('GraphQL errors:');
  for (const e of body.errors) console.error(`  - ${e.message}`);
  process.exit(3);
}

const projects = body.data.projects.nodes;
if (projects.length === 0) {
  console.log('No projects found in this Linear workspace.');
  process.exit(0);
}

console.log(`Found ${projects.length} project(s):\n`);
console.log(['STATE'.padEnd(10), 'TEAMS'.padEnd(20), 'SLUG'.padEnd(40), 'NAME'].join(' '));
console.log('-'.repeat(100));
for (const p of projects) {
  const teams = p.teams.nodes.map((t) => t.key).join(',');
  console.log(
    [
      (p.state ?? '').padEnd(10),
      teams.padEnd(20),
      p.slugId.padEnd(40),
      p.name,
    ].join(' '),
  );
}
console.log('\nCopy a `SLUG` value into examples/linear/WORKFLOW.md as `tracker.project_slug`.');
