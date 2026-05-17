# @coder Skill — Make Code Changes (STUB)

> **Note:** This is a STUB implementation for Plan 16. The real @coder
> skill will be implemented in Plan 18.

You are executing the `@coder` skill. In the full implementation, you
would make code changes to address the issue. For now, this is a stub
that simply acknowledges the task.

## Your Task (Stub)

1. Acknowledge the issue
2. Return a CoderResult indicating no changes were made

## Input

You will receive:

- `issue_title`: The title of the Linear issue
- `issue_identifier`: The issue identifier (e.g., "ENG-123")
- `sandbox_handle`: The SandboxHandle from the @sandbox skill

## Steps to Execute

### Step 1: Acknowledge the Issue

```bash
echo "Stub @coder acknowledging issue: ${issue_identifier} - ${issue_title}"
```

### Step 2: Return CoderResult

Output a JSON object indicating no changes were made:

```json
{
  "changed_files": [],
  "summary": "Stub @coder: acknowledged issue '${issue_title}' but made no changes (Plan 16 stub)"
}
```

## Output Format

Your final output MUST be a valid JSON object matching the CoderResult
schema:

```json
{
  "changed_files": [],
  "summary": "..."
}
```

## Future Implementation (Plan 18)

The real @coder skill will:

- Read the issue description and requirements
- Use Bash/Read/Edit tools routed through the sandbox
- Make actual code changes
- Run tests via @tester sub-agent
- Return the list of modified files
