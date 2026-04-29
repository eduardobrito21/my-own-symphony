# Claude Agent SDK TypeScript: API Reference & Notes

**Last updated:** April 2026  
**SDK package:** `@anthropic-ai/claude-agent-sdk`  
**Docs:** https://code.claude.com/docs/en/agent-sdk/typescript  
**GitHub:** https://github.com/anthropics/claude-agent-sdk-typescript

---

## 1. Entry Point

**The canonical entry point is the `query()` function.**

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: 'Your task here',
  options: {
    model: 'claude-sonnet-4-5',
    // ... other options
  },
})) {
  // Handle each message (SDKMessage union)
}
```

**Function signature:**

```typescript
function query({
  prompt,
  options
}: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query extends AsyncGenerator<SDKMessage, void>;
```

**Key point:** `query()` returns an async generator. Each iteration yields one `SDKMessage` (a discriminated union). The loop continues until the agent finishes or hits an error.

**Docs:** https://code.claude.com/docs/en/agent-sdk/typescript

---

## 2. Session Resumption

**To capture a session ID:**

- Read it from the `session_id` field on any `SDKResultMessage` (the final message after tool calls complete).
- In TypeScript, `SDKSystemMessage` (subtype: `'init'`) also has a direct `session_id` field.

**To resume a session:**

```typescript
for await (const message of query({
  prompt: 'Continue from before',
  options: {
    resume: sessionId, // Pass the ID from the first session
    model: 'claude-sonnet-4-5',
    // ... other options
  },
})) {
  // Conversation history is fully restored
}
```

**Field name:** `resume` (not `sessionId`, `conversationId`, or `continue_session`).

> ⚠️ **Critical: do NOT pair `resume:` with `persistSession: false`.**
> The SDK looks the session up in its own `~/.claude/projects/`
> store before resuming. Disabling persistence means every resume
> attempt fails with `"No conversation found with session ID: <id>"`.
> If you want a workspace-local pointer to the latest session id,
> store it in your own metadata file (we use `<workspace>/.symphony/session.json`)
> AND let the SDK persist its transcript to `~/.claude/projects/`.
> Lesson learned in smoke run #2 (2026-04-29) — see Plan 07
> Decision log "Bug 3".

**Multi-turn convenience (TypeScript V2 preview, unstable):**

```typescript
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from '@anthropic-ai/claude-agent-sdk';

// Create
await using session = unstable_v2_createSession({ model: 'claude-sonnet-4-5' });
await session.send('First message');
const sessionId = session.sessionId;

// Resume
await using resumed = unstable_v2_resumeSession(sessionId, { model: 'claude-sonnet-4-5' });
await resumed.send('Follow-up');
```

**Docs:**

- V1 (stable): https://code.claude.com/docs/en/agent-sdk/sessions
- V2 (preview): https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview

---

## 3. Custom Tools

**Define tools with the `tool()` helper. Input schema uses Zod.**

```typescript
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const linearGraphql = tool(
  'linear_graphql',
  'Execute a GraphQL query against the Linear API',
  {
    query: z.string().describe('GraphQL query string'),
    variables: z.record(z.any()).optional().describe('Query variables'),
  },
  async (args) => {
    // args is typed: { query: string; variables?: Record<string, any> }
    try {
      const response = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.LINEAR_API_KEY}`,
        },
        body: JSON.stringify({
          query: args.query,
          variables: args.variables || {},
        }),
      });
      const data = await response.json();
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `GraphQL error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Wrap in an MCP server
const linearServer = createSdkMcpServer({
  name: 'linear',
  version: '1.0.0',
  tools: [linearGraphql],
});

// Pass to query()
for await (const msg of query({
  prompt: 'Get my open issues',
  options: {
    mcpServers: { linear: linearServer },
    allowedTools: ['mcp__linear__linear_graphql'],
    model: 'claude-sonnet-4-5',
  },
})) {
  // ...
}
```

**Schema format:**

- **Input:** Always a Zod schema (`.z.object()` shape).
- **Return:** Must be `{ content: Array<{ type: "text" | "image" | "resource"; ... }>; isError?: boolean }`.

**Tool name format:** `mcp__{server_name}__{tool_name}` (e.g., `mcp__linear__linear_graphql`).

**Docs:** https://code.claude.com/docs/en/agent-sdk/custom-tools

---

## 4. System Prompt / Skill Loading

**Option 1: Inline string**

```typescript
options: {
  systemPrompt: "You are a senior TypeScript developer. ...",
  // ...
}
```

**Option 2: Preset + append**

```typescript
options: {
  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: "Additional instructions here"
  },
  // ...
}
```

**To load a markdown file into the system prompt:**

```typescript
import { readFileSync } from 'fs';

const skillMarkdown = readFileSync('/path/to/commands/linear.md', 'utf-8');

for await (const msg of query({
  prompt: 'Your task',
  options: {
    systemPrompt: `${skillMarkdown}\n\nNow, ${yourTask}`,
    model: 'claude-sonnet-4-5',
  },
})) {
  // ...
}
```

**Load once and reuse across turns:**

```typescript
// Module scope
const LINEAR_SKILL = readFileSync('./commands/linear.md', 'utf-8');

// In your agent function
for await (const msg of query({
  prompt: newPrompt,
  options: {
    resume: sessionId,
    systemPrompt: LINEAR_SKILL,
    // ...
  },
})) {
  // ...
}
```

**Note:** The Agent SDK reads system prompts on each call; they are not sticky across resumed sessions. Include the skill markdown in every call to a resumed session if you want it to persist.

**Docs:** https://code.claude.com/docs/en/agent-sdk/typescript (Options → `systemPrompt`)

---

## 5. Event Stream & Message Types

**`query()` returns an async generator of `SDKMessage` objects.**

```typescript
type SDKMessage =
  | SDKSystemMessage // type: 'system', subtype: 'init' | 'plan' | ...
  | SDKUserMessage // type: 'user', (rarely seen in output)
  | SDKAssistantMessage // type: 'assistant', content: Block[]
  | SDKPartialAssistantMessage // type: 'partial_assistant', (streaming delta)
  | SDKToolUseMessage // type: 'tool_use', tool_name, input
  | SDKToolResultMessage // type: 'tool_result', content
  | SDKResultMessage // type: 'result', subtype: 'success' | 'error_*'
  | SDKStatusMessage // type: 'status', (progress/info)
  | SDKMirrorErrorMessage; // type: 'mirror_error', (sessionStore append failed)
// ... others
```

**Common discriminators:**

```typescript
if (message.type === 'assistant') {
  // Reasoning/analysis from Claude. message.message.content has TextBlock, ToolUseBlock, etc.
  for (const block of message.message.content) {
    if (block.type === 'text') {
      console.log(block.text);
    } else if (block.type === 'tool_use') {
      console.log(`Called tool: ${block.name}`);
    }
  }
}

if (message.type === 'tool_result') {
  // Tool returned a result. message.content is the result.
  console.log(message.content);
}

if (message.type === 'result') {
  // Final result. Always has subtype, session_id, usage, cost, etc.
  console.log(message.subtype); // 'success' | 'error_max_turns' | 'error_max_budget_usd' | ...
  console.log(message.session_id);
  console.log(message.usage); // { input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens? }
  console.log(message.total_cost_usd);
}

if (message.type === 'status') {
  // Progress updates. Helpful for UI/logging.
  console.log(message.status); // string
}
```

**Mapping to a custom `AgentEvent` union:**

```typescript
type AgentEvent =
  | { type: "thinking"; text: string }
  | { type: "tool_call"; toolName: string; input: unknown }
  | { type: "tool_result"; result: unknown }
  | { type: "text"; text: string }
  | { type: "done"; cost: number; sessionId: string };

// In your loop:
for await (const msg of query(...)) {
  let event: AgentEvent | null = null;

  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "text") {
        event = { type: "text", text: block.text };
      } else if (block.type === "thinking") {
        event = { type: "thinking", text: block.thinking };
      }
    }
  } else if (msg.type === "tool_use") {
    event = { type: "tool_call", toolName: msg.name, input: msg.input };
  } else if (msg.type === "result" && msg.subtype === "success") {
    event = {
      type: "done",
      cost: msg.total_cost_usd ?? 0,
      sessionId: msg.session_id
    };
  }

  if (event) {
    // Process your custom event
  }
}
```

**Docs:** https://code.claude.com/docs/en/agent-sdk/typescript

---

## 6. Abort / Timeouts

**Yes, `AbortController` is supported.**

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

try {
  for await (const msg of query({
    prompt: 'Your task',
    options: {
      abortController: controller, // Pass the controller
      model: 'claude-sonnet-4-5',
      // ...
    },
  })) {
    // ...
  }
} catch (error) {
  if (error instanceof Error && error.name === 'AbortError') {
    console.log('Query timed out');
  }
} finally {
  clearTimeout(timeoutId);
}
```

**Behavior on abort:**

- The async generator throws an `AbortError`.
- The agent loop stops immediately.
- No cleanup is automatic; you must handle the exception.

**Known issue (GitHub #69):**
Using `abortController` to cancel immediately after the init message can cause subsequent resumes with the same `session_id` to fail. Workaround: Let the agent complete at least one full turn before aborting, or don't resume a forcibly-aborted session.

**Docs:** https://code.claude.com/docs/en/agent-sdk/typescript (Options → `abortController`)

---

## 7. Model Identifier

**Current canonical identifiers for Claude Sonnet 4.5:**

| Model              | Identifier                   | Notes                                          |
| ------------------ | ---------------------------- | ---------------------------------------------- |
| Claude Sonnet 4.5  | `claude-sonnet-4-5`          | Latest stable (alias, always points to latest) |
| Sonnet 4.5 (dated) | `claude-sonnet-4-5-20250929` | Specific release (Sept 29, 2025)               |
| Claude Opus 4.7    | `claude-opus-4-7`            | Most capable; higher latency & cost            |

**Pass to the `model` option:**

```typescript
options: {
  model: "claude-sonnet-4-5",
  // or
  model: "claude-sonnet-4-5-20250929",
  // or
  model: "claude-opus-4-7"
}
```

**Default:** If not specified, the CLI default is used (typically the latest Sonnet).

**Docs:** https://platform.claude.com/docs/en/about-claude/models/overview

---

## 8. Authentication

**The SDK reads `ANTHROPIC_API_KEY` from `process.env` automatically.**

```typescript
// No explicit auth needed if ANTHROPIC_API_KEY is set
for await (const msg of query({ prompt: "...", options: {...} })) {
  // ...
}
```

**Setting the key:**

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Or in code:

```typescript
process.env.ANTHROPIC_API_KEY = 'sk-ant-...';
```

**Alternative auth methods (cloud providers):**

- **AWS Bedrock:** Set `CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials.
- **Google Vertex AI:** Set `CLAUDE_CODE_USE_VERTEX=1` + Google Cloud credentials.
- **Azure AI Foundry:** Set `CLAUDE_CODE_USE_FOUNDRY=1` + Azure credentials.

**Docs:** https://code.claude.com/docs/en/agent-sdk/quickstart (Setup section)

---

## 9. Token / Usage Reporting

**Usage is reported in the `SDKResultMessage` (final message after each query).**

```typescript
for await (const msg of query({...})) {
  if (msg.type === "result") {
    console.log({
      usage: msg.usage,
      // {
      //   input_tokens: number,
      //   output_tokens: number,
      //   cache_creation_input_tokens?: number,
      //   cache_read_input_tokens?: number
      // }
      total_cost_usd: msg.total_cost_usd,
      session_id: msg.session_id,
      subtype: msg.subtype // 'success' | 'error_*'
    });
  }
}
```

**Note:** Token counts are per-turn (per query call), not per-event. Cache tokens (creation + read) are included separately.

**Per-event granularity:** Not available. Usage is summarized at the end of each `query()` call.

**Docs:** https://code.claude.com/docs/en/agent-sdk/typescript (SDKResultMessage)

---

## 10. Recent Breaking Changes & Risks

### Breaking Changes (Last 6 Months)

**1. Environment variable handling (April 2026)**

- **Change:** `options.env` now _replaces_ `process.env` instead of overlaying it.
- **Migration:** Pass `env: { ...process.env, MY_VAR: "value" }` to add/override specific vars.

**2. Context window beta retirement (April 30, 2026)**

- **Change:** `context-1m-2025-08-07` is no longer supported. Requests exceeding 200k tokens error.
- **Impact:** If you were using the 1M-token beta, downgrade to 200k or switch to Opus 4.7.

**3. Session store API (new, April 2026)**

- **Added:** `sessionStore` option (alpha) + `SDKMirrorErrorMessage` for failed remote appends.
- **Note:** This is additive; existing code is unaffected.

### Risks & Open Items

1. **AbortController + resume:**
   - Canceling a session immediately after init and then resuming can fail (GitHub #69).
   - **Mitigation:** Avoid aborting before the first tool call, or don't resume an aborted session.

2. **System prompt persistence:**
   - System prompts are not sticky across resumed sessions.
   - **Solution:** Include the skill markdown on every query to a resumed session.

3. **V2 SDK stability:**
   - `unstable_v2_createSession()` / `unstable_v2_resumeSession()` are preview-only.
   - APIs may change. Use stable V1 (`query()`) for production.

4. **No explicit abort signal on `stream()`:**
   - V2's `session.stream()` does not accept an `AbortSignal` parameter.
   - **Workaround:** Wrap the stream loop in a timeout or call `session.close()` manually.

5. **Tool name collisions:**
   - If your custom tool's name collides with a built-in (e.g., `Read`), use the MCP-qualified name (`mcp__linear__linear_graphql`) in `allowedTools`.

6. **Session storage across hosts:**
   - Sessions are stored under `~/.claude/projects/<encoded-cwd>/`.
   - To resume on a different machine, mirror the session file or use `SessionStore` adapter (alpha).

### Current SDK Version

- **Stable:** V1 (`query()` function).
- **Preview:** V2 (`unstable_v2_createSession()`).
- **Package:** `@anthropic-ai/claude-agent-sdk` (check GitHub releases for current version).

**See:** https://github.com/anthropics/claude-agent-sdk-typescript/releases

---

## Summary Table

| Question                   | Answer                                                                          |
| -------------------------- | ------------------------------------------------------------------------------- |
| **Entry point**            | `query()` function, returns async generator of `SDKMessage`                     |
| **Session ID capture**     | Read from `SDKResultMessage.session_id` or `SDKSystemMessage.session_id` (init) |
| **Session resumption**     | `options.resume = sessionId` on next `query()` call                             |
| **Custom tools**           | `tool()` helper + `createSdkMcpServer()`, schema uses Zod                       |
| **System prompt**          | `options.systemPrompt` (string or `{ type: 'preset'; preset: 'claude_code' }`)  |
| **Skill file loading**     | Read file, pass as `options.systemPrompt`; include on every resumed call        |
| **Event stream**           | Async generator; discriminated union of `SDKMessage` types                      |
| **Abort/timeout**          | Pass `AbortController` to `options.abortController`; throws on abort            |
| **Model ID**               | `"claude-sonnet-4-5"` or `"claude-opus-4-7"`                                    |
| **Auth**                   | Reads `ANTHROPIC_API_KEY` from `process.env` automatically                      |
| **Token counts**           | In `SDKResultMessage.usage` (per-turn, not per-event)                           |
| **Recent breaking change** | `options.env` replaces instead of overlays `process.env` (April 2026)           |

---

**References:**

- [Agent SDK TypeScript docs](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Custom tools guide](https://code.claude.com/docs/en/agent-sdk/custom-tools)
- [Session management](https://code.claude.com/docs/en/agent-sdk/sessions)
- [V2 preview (unstable)](https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview)
- [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [GitHub releases](https://github.com/anthropics/claude-agent-sdk-typescript/releases)
