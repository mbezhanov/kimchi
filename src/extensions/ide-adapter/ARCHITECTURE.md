# IDE Adapter Architecture

Internal documentation for Kimchi contributors working on the `ide-adapter` extension.

## Overview

The adapter discovers IDE plugins via filesystem lockfiles, opens a WebSocket MCP connection, proxies all IDE tools into the agent namespace, and handles two notification types: `at_mentioned` and `selection_changed`.

## Tool Call Behaviour

When the agent calls a proxied IDE tool (`ide_<name>`), the harness forwards it to the IDE and normalises the response:

| Scenario | Harness response |
|---|---|
| Success | `content: [{type: "text", text: "<JSON-stringified result>"}]`, `details: <raw result>` |
| IDE connection lost mid-call | `content: [{type: "text", text: "IDE connection lost"}]`, `details: {error: "IDE connection lost"}` |
| Tool throws | `content: [{type: "text", text: "IDE tool error: <message>"}]`, `details: {error: <message>}` |
| Call aborted (signal) | `content: [{type: "text", text: "Tool call aborted"}]`, `details: {error: "aborted"}` |

## Notification Handling

### `at_mentioned`

- **UI active** — the mention text is pasted into the editor immediately via `pasteToEditor`, and a status update is triggered so the text renders without waiting for the next keystroke.
- **UI not available** — the mention is queued. On the next user input, all queued mentions are prepended to the prompt text.
- **Queue cap**: `MAX_PENDING_MENTIONS = 100`. Oldest entries are dropped when exceeded.

### `selection_changed`

selection_changed now surfaces the current IDE selection in the CLI via two complementary mechanisms:

1. **Live input-box indicator** — when `currentCtx.hasUI` is true, the harness calls `setIdeSelectionIndicator(formatAtMention(selection))` (from `src/extensions/ui.ts`), rendering the current selection as a chip segment in the input box's top border (`@file:range`, project-relative path). The chip updates on every `selection_changed` notification, mirroring the IDE's live selection.
2. **Auto-attach on send** — the selection is also held in the per-session `_latestSelection` slot. On every user input (`pi.on('input')`), if `_latestSelection` is set, `formatAtMention(_latestSelection)` is prepended to the outgoing prompt text via the existing `{ action: "transform" }` path — without the user typing `@`.

**Sticky (non-consumed) semantics.** `_latestSelection` is *not* cleared after a send. It stays "in sync" with the IDE: every send re-attaches whatever is currently selected, until a new `selection_changed` notification overwrites it. This matches the "always in sync" model rather than a one-shot queue (contrast with `at_mentioned`, which *is* drained on send).

**Deduplication.** If the user explicitly at-mentions the exact same range they have selected (e.g. Cmd+Option+K on the active selection), the selection prefix is suppressed for that send to avoid a double `@file:range` prefix. Dedup is by exact string equality of the formatted mention, so path-form mismatches (absolute vs. relativized) would not dedup — both code paths relativize identically via `relative(cwd, …)`, so the strings match in practice.

**v1 limitation — no explicit clear-on-collapse.** When the IDE editor or selection collapses to nothing, the IDE plugin is expected to send a `selection_changed` with `lineStart: 0, lineEnd: 0` (or the plugin may simply stop sending). In v1 the harness does **not** auto-clear `_latestSelection` or the indicator on its own initiative — it relies on the plugin's next notification to overwrite/clear the state. The indicator is only explicitly nulled on `session_shutdown` (to avoid persisting across reused `PromptEditor` instances). A future v2 may add an explicit "selection cleared" signal or a `null`-filePath convention.

## Lockfile Matching

1. Filter lockfiles to those whose `pid` is still alive (`kill(pid, 0)`).
2. Prefer a lockfile whose `workspaceFolders` contains the current working directory (exact match or nested path).
3. If no exact match exists, **fall back to the first alive lockfile**.

## Runtime Constants

| Constant | Value | Description |
|---|---|---|
| `POLL_INTERVAL_MS` | `5000` | How often the harness rescans for new lockfiles |
| `MAX_RECONNECT_RETRIES` | `3` | Failed connection attempts before the extension stops polling for that session |
| `DEFAULT_HANDSHAKE_TIMEOUT_MS` | `10000` | WebSocket `open` timeout |
| `MAX_PENDING_MENTIONS` | `100` | Max `at_mentioned` queue size |

## Detailed Lifecycle

```
IDE opens project
   └─> starts WebSocket server
   └─> writes lockfile

Kimchi starts or opens a new session
   └─> scans lockfile directory (every 5 s)
   └─> finds matching workspace folder (or first alive lockfile)
   └─> connects WebSocket (?token= query param)
   └─> MCP initialize / initialized handshake (10 s timeout)
   └─> calls tools/list
   └─> registers tools as ide_<name>

User selects code and clicks "Send to Kimchi"
   └─> IDE sends at_mentioned notification
   └─> harness pastes immediately if UI active, else queues
   └─> on next user input, any queued mentions are prepended as @file:range

IDE cursor/selection moves
   └─> IDE sends selection_changed notification (plugin-side ~150 ms debounce)
   └─> harness renders @file:range as an input-box indicator chip
   └─> harness stores selection as sticky _latestSelection

User submits a prompt
   └─> pi.on('input') prepends @file:range from _latestSelection (sticky, not consumed)
   └─> dedups against any explicitly queued at-mention of the same range

IDE closes project
   └─> deletes lockfile
   └─> WebSocket closes
   └─> harness onDisconnect fires immediately
   └─> harness nulls connection and will reconnect on next poll
```

## Design Notes

- **Generic, not IDE-specific** — the harness contains no JetBrains/VS Code/etc. logic. Everything is driven by the lockfile and MCP tool list.
- **Custom transport** — the WebSocket upgrade uses a query parameter (`token`). The harness implements its own lightweight transport on top of the `ws` package.
