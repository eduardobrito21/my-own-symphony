#!/usr/bin/env node
// Create a Linear issue for the Plan 20 @planner smoke. One-shot.
//
// Run from repo root:
//   node --env-file=.env scripts/create-linear-issue.mjs

const apiKey = process.env.LINEAR_API_KEY;
if (!apiKey) {
  console.error('ERROR: LINEAR_API_KEY not set');
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status}:`, await res.text());
    process.exit(2);
  }
  const body = await res.json();
  if (body.errors) {
    console.error('GraphQL errors:', JSON.stringify(body.errors, null, 2));
    process.exit(3);
  }
  return body.data;
}

// Step 1: find the EDU team + Smoke Test project.
const projects = await gql(`
  query { projects(first: 50) {
    nodes { id name slugId teams { nodes { id key name } } }
  }}
`);
const project = projects.projects.nodes.find((p) => p.slugId === 'a532c6a9e9bb');
if (!project) {
  console.error('Could not find Smoke Test project (slug a532c6a9e9bb)');
  process.exit(4);
}
const team = project.teams.nodes.find((t) => t.key === 'EDU') ?? project.teams.nodes[0];
console.log(`Project: ${project.name} (id ${project.id})`);
console.log(`Team:    ${team.key} (id ${team.id})`);

// Step 2: create an issue with a description that should trigger @planner
// to write a plan (multi-step, has design choices).
const title = 'Add a Contributing section to the README';
const description = `Add a top-level "## Contributing" section to the repo's README.md.

The section should include three subsections, each as its own \`###\` heading:

1. **Prerequisites** — list what a contributor needs installed (Node 22+, pnpm, git).
2. **Running the tests** — a one-liner showing the test command.
3. **Reporting bugs** — say to open a GitHub issue with reproduction steps.

Keep the prose concise — one or two sentences per subsection is plenty. Don't add a table of contents, don't reorganise the rest of the README, don't add badges. Just append the new section near the bottom (before any existing "License" section if one exists, otherwise at the end of the file).`;

const created = await gql(
  `
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier title url state { name } }
    }
  }
`,
  {
    input: {
      teamId: team.id,
      projectId: project.id,
      title,
      description,
    },
  },
);

if (!created.issueCreate.success) {
  console.error('issueCreate returned success=false');
  process.exit(5);
}

const issue = created.issueCreate.issue;
console.log('\nCreated issue:');
console.log(`  ${issue.identifier} — ${issue.title}`);
console.log(`  state: ${issue.state.name}`);
console.log(`  url:   ${issue.url}`);
