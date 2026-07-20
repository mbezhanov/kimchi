# ACP Extended Capabilities (`_kimchi.dev/`)

Kimchi's ACP server advertises a set of extended (non-spec) capabilities under the
`kimchi.dev` namespace. Clients feature-detect them via the `initialize` response and
opt in per-method.

## Capability negotiation

When a client calls `initialize`, the agent responds with an
`agentCapabilities._meta["kimchi.dev"]` object whose keys are capability flag names
and whose values are booleans:

```jsonc
{
  "agentCapabilities": {
    "_meta": {
      "kimchi.dev": {
        "pi_notify": true,   // agent→client: UI notifications
        "pi_editor": true,   // agent→client: editor dialog requests
        "get_budget": true   // client→agent: account budget query
      }
    }
  }
}
```

A client signals support for an **agent→client** capability (`pi_notify`, `pi_editor`)
by mirroring the same flag back in its own `clientCapabilities._meta["kimchi.dev"]`.
Client→agent capabilities (`get_budget`) are advertised by the agent only — the client
may invoke them whenever the flag is `true`.

If the agent calls an agent→client method the client hasn't opted into, the call is
dropped and a single `[ACP]` warning is emitted as an `agent_message_chunk` per
method per session.

## Methods by direction

| Method | Direction | Transport | Capability flag |
| --- | --- | --- | --- |
| `_kimchi.dev/pi_notify` | agent → client | `extNotification` (fire-and-forget) | `pi_notify` |
| `_kimchi.dev/pi_editor` | agent → client | `extMethod` (request/response) | `pi_editor` |
| `_kimchi.dev/getBudget` | client → agent | `extMethod` (request/response) | `get_budget` |

---

## `_kimchi.dev/pi_notify` (agent → client notification)

A fire-and-forget notification used by the agent to drive client-side UI affordances
that have no spec equivalent: toasts, status bar, inline widgets, and editor text
insertion. The agent sends it via `conn.extNotification`; no response is expected.

**Envelope**

All `pi_notify` payloads share a common envelope:

```jsonc
{
  "type": "extension_ui_request",
  "id": "<uuid>",
  "sessionId": "<session-id>",
  "method": "<sub-method>",
  // …sub-method-specific fields
}
```

The `method` field selects the sub-method. Unknown sub-methods must be ignored by
the client.

### Sub-method: `notify`

Display a transient toast/message.

| Field | Type | Description |
| --- | --- | --- |
| `message` | `string` | Message body to display. |
| `notifyType` | `string \| undefined` | Severity: `"info"`, `"warning"`, `"error"`, or omitted for default. |

### Sub-method: `setStatus`

Update a status-bar entry identified by `statusKey`.

| Field | Type | Description |
| --- | --- | --- |
| `statusKey` | `string` | Stable key for the status slot (e.g. `"phase"`, `"model"`). |
| `statusText` | `string` | Text to render in that slot. |

### Sub-method: `setWidget`

Render a multi-line inline widget. Component factories (dynamic TUI trees) are
silently dropped — only static `string[]` content is forwarded.

| Field | Type | Description |
| --- | --- | --- |
| `widgetKey` | `string` | Stable key identifying the widget slot. |
| `widgetLines` | `string[]` | Lines of text to render. |
| `widgetPlacement` | `string \| undefined` | Placement hint (client-defined). |

### Sub-method: `set_editor_text`

Replace the contents of the user's editor input with `text`.

| Field | Type | Description |
| --- | --- | --- |
| `text` | `string` | Text to place in the editor. |

---

## `_kimchi.dev/pi_editor` (agent → client request)

A request/response call used when the agent needs multi-line text input from the
user (e.g. drafting a commit message, editing a diff). Restricted JSON Schema — used
by ACP's elicitation — has no multi-line text primitive, so this dedicated method is
used instead. The agent calls it via `conn.extMethod` only when the client advertises
the `pi_editor` capability.

**Request**

```jsonc
{
  "type": "extension_ui_request",
  "id": "<uuid>",
  "sessionId": "<session-id>",
  "method": "editor",
  "title": "<dialog title>",
  "prefill": "<initial text>"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `title` | `string` | Dialog title. |
| `prefill` | `string` | Initial text placed in the editor. |

**Response**

```jsonc
{
  "value": "<edited text>"   // present on accept
  "cancelled": true          // present if the user dismissed the dialog
}
```

| Field | Type | Description |
| --- | --- | --- |
| `value` | `string \| undefined` | The edited text. Present when the user accepts. |
| `cancelled` | `boolean \| undefined` | `true` if the user cancelled/dismissed. |

On transport error the agent treats the call as cancelled and resolves `undefined`.

---

## `_kimchi.dev/getBudget` (client → agent request)

Returns the authenticated user's **account-level** billing status: plan, remaining
credits, credit status, and per-scope budget usage. Intended for rendering a
"Billing"/"Budget" panel in IDE clients.

Session-level cost (tokens + USD) is **not** included here — retrieve it via the
upstream `AgentSession.getSessionStats()` API instead.

**Request**

```jsonc
{ }
```

No params. Account budget is not session-scoped, so no `sessionId` is required.

**Response**

```jsonc
{
  "account": {
    "serverless": true,
    "plan": "coder",
    "isPaidTier": true,
    "remainingCredits": 42.5,
    "creditStatus": "ok",
    "restrictedMode": false,
    "budget": {
      "period": { "startTime": "2026-07-01T00:00:00.000Z", "endTime": "2026-07-31T23:59:59.999Z" },
      "budgets": [
        {
          "scope": "USER",
          "scopeId": "user-1",
          "budgetType": "PER_USER",
          "budgetLimitUsd": "100",
          "totalSpendUsd": "12.34",
          "providerBudgets": [
            { "provider": "anthropic", "limitType": "CAPPED", "budgetLimitUsd": "50", "usageUsd": "7" }
          ]
        }
      ]
    },
    "updatedAt": "2026-07-20T00:00:00.000Z"
  }
}
```

The `account` field is `null` when:

- No Cast AI endpoint is configured (e.g. BYOK / serverless / community setup).
- The credits/budget fetch failed or timed out (5s per endpoint).

### Field reference

| Field | Type | Description |
| --- | --- | --- |
| `serverless` | `boolean \| undefined` | `false` when the account is on a serverless/credits-less backend. |
| `plan` | `"community" \| "coder" \| "teams" \| "enterprise" \| undefined` | Account billing plan. |
| `isPaidTier` | `boolean \| undefined` | Whether the account is on a paid (non-community) plan. |
| `remainingCredits` | `number \| undefined` | Remaining credit balance in USD. |
| `creditStatus` | `"ok" \| "low" \| "exhausted" \| undefined` | Derived credit health. `low` < $5.00. |
| `restrictedMode` | `boolean \| undefined` | `true` when the account is out of credits and throttled. |
| `budget` | `BudgetSnapshot \| undefined` | Per-scope spend/limit table. Same shape as the `/budget` slash command. |
| `updatedAt` | `string` (ISO 8601) | When this status was last refreshed. |

### `BudgetSnapshot`

| Field | Type | Description |
| --- | --- | --- |
| `period.startTime` | `string` (ISO 8601) | Budget window start (UTC). |
| `period.endTime` | `string` (ISO 8601) | Budget window end (UTC). |
| `budgets` | `BudgetEntry[]` | One entry per budget scope. |

### `BudgetEntry`

| Field | Type | Description |
| --- | --- | --- |
| `scope` | `string` | `"API_KEY"`, `"USER"`, `"TEAM_PER_USER"`, `"TEAM_POOLED"`, `"ORGANIZATION_SOFT"`, or `"ORGANIZATION_HARD"`. |
| `scopeId` | `string` | Stable id for the scope owner (e.g. user id, team id). |
| `budgetType` | `string \| undefined` | `"PER_USER"` or a provider-specific variant when applicable. |
| `budgetLimitUsd` | `string` | Budget limit in USD (decimal string). Empty string means unlimited. |
| `totalSpendUsd` | `string` | Total spend against this budget in USD (decimal string). |
| `providerBudgets` | `BudgetProvider[]` | Per-provider breakdown. |

### `BudgetProvider`

| Field | Type | Description |
| --- | --- | --- |
| `provider` | `string` | Provider name (e.g. `"anthropic"`, `"openai"`). |
| `limitType` | `string` | `"CAPPED"`, `"DISABLED"`, `"UNLIMITED"`, or a provider-prefixed variant. |
| `budgetLimitUsd` | `string` | Provider budget limit in USD. Empty when unlimited/disabled. |
| `usageUsd` | `string` | Provider spend in USD (decimal string). |

### Polling guidance

Each call triggers a fresh fetch against the Cast AI credits and budget endpoints
(timeout-bounded at 5 seconds). For a live-updating panel, poll on a 30–60 second
interval rather than on every UI focus — this matches the cadence of the agent's own
periodic billing refresher and avoids saturating the endpoints.

---

## Adding a new capability

1. **Pick the direction.** Agent→client UI calls go in `AVAILABLE_METHODS` in
   `src/modes/acp/capabilities.ts` (gated on `getClientSupportsMethod`). Client→agent
   RPCs go in `AGENT_RPC_METHODS` (same file). Keep the two maps separate — their
   capability semantics differ.
2. **Wire the handler.** Agent→client: extend `createAcpUIContext` in
   `src/modes/acp/acp-ui-context.ts`. Client→agent: add a branch to `extMethod` in
   `src/modes/acp/server.ts`.
3. **Advertise.** Both maps are reduced into `ADVERTISED_CAPABILITIES` /
   `ADVERTISED_AGENT_RPC`, which are merged into `initialize._meta["kimchi.dev"]` —
   no manual registration needed.
4. **Name the wire method** `_${CAPABILITIES_KEY}/<name>` (i.e. `_kimchi.dev/<name>`).
   Use noun-style for data queries (`getBudget`), verb-style for UI actions
   (`pi_editor`, `pi_notify`).
5. **Document it here** — add a section with direction, transport, request/response
   shapes, and a field reference table.
6. **Test it** — add a `describe` block in `src/modes/acp/server.test.ts` (client→agent)
   or `src/modes/acp/acp-ui-context.test.ts` (agent→client).
