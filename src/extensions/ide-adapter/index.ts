import { readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { loadConfig } from "../../config.js"
import { setIdeSelectionIndicator } from "../ui.js"
import { formatAtMention } from "./at-mentions.js"
import { applyEditInput } from "./edit-apply.js"
import { findMatchingLockfile, getLockfileDir, parseLockfile, scanLockfiles } from "./lockfile.js"
import { connectToIde } from "./mcp-client.js"
import type { AtMentionNotification, IdeConnection, IdeTool, SelectionChangedNotification } from "./types.js"

const POLL_INTERVAL_MS = 5000

/** Max number of at-mentions to queue before dropping oldest. */
const MAX_PENDING_MENTIONS = 100

/** Max reconnect attempts before giving up on discovery polling. */
const MAX_RECONNECT_RETRIES = 3

/** Tool names that mutate files and must be gated by IDE approval when enabled. */
const APPROVAL_GATED_TOOLS = new Set(["write", "edit"])

/**
 * Generate a short unique id for each proposed change, used for tool-window
 * queue tracking on the IDE side. Not security-sensitive — `Date.now()` +
 * random suffix is sufficient.
 */
function generateChangeId(): string {
	return `chg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** Read a file's current contents, returning "" if missing or unreadable. */
function readCurrentContent(filePath: string): string {
	try {
		return readFileSync(filePath, "utf-8")
	} catch {
		return ""
	}
}

/**
 * Compute the proposed new content for a `write` or `edit` tool call.
 *
 * Returns `{ filePath, originalContent, newContent }` on success, or `null`
 * when the inputs are malformed (e.g. `edit` with an `oldText` not present in
 * the file — in that case we defer to the tool's own validation rather than
 * duplicating the error message).
 */
function computeProposedChange(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): { filePath: string; originalContent: string; newContent: string } | null {
	const rawPath =
		typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : ""
	if (!rawPath) return null
	const filePath = resolve(cwd, rawPath)
	const originalContent = readCurrentContent(filePath)

	if (toolName === "write") {
		const newContent = typeof input.content === "string" ? input.content : ""
		return { filePath, originalContent, newContent }
	}

	// edit
	const newContent = applyEditInput(originalContent, input as Parameters<typeof applyEditInput>[1])
	if (newContent === null) return null
	return { filePath, originalContent, newContent }
}

/**
 * Call the IDE's `proposeChange` tool and return whether the user approved.
 *
 * Returns `true` on approval, `false` on rejection/timeout/dismissal, and
 * `null` when the IDE call itself failed (network error, tool not exposed,
 * malformed response). On `null` the hook falls back to letting the write
 * proceed — approval is best-effort, never a hard block on infrastructure
 * failure.
 *
 * The MCP `tools/call` response is a `CallToolResult` envelope:
 * ```
 * { content: [{ type: "text", text: "{\"approved\": true, ...}" }] }
 * ```
 * The actual `{ approved, changeId }` payload is JSON-stringified inside the
 * first text content block. We must unwrap and parse it before checking the
 * `approved` field — checking `"approved" in result` on the envelope always
 * returns false (the envelope has `content`, not `approved`), which would
 * cause every call to fall into the `null` fallback and let writes proceed
 * regardless of the user's decision.
 */
async function requestIdeApproval(
	connection: IdeConnection,
	params: { filePath: string; originalContent: string; newContent: string; changeId: string },
	signal: AbortSignal | undefined,
): Promise<boolean | null> {
	try {
		const result = await connection.callTool("proposeChange", params)
		if (signal?.aborted) return null
		const payload = unwrapMcpToolResult(result)
		if (payload && typeof payload === "object" && "approved" in payload) {
			return Boolean((payload as { approved: unknown }).approved)
		}
		return null
	} catch {
		return null
	}
}

/**
 * Extract the JSON payload from an MCP `tools/call` `CallToolResult` envelope.
 *
 * The IDE plugin's `McpJsonRpc.kt` wraps every tool result as:
 * ```
 * { content: [{ type: "text", text: "<json-stringified-result>" }] }
 * ```
 * This helper parses the first text content block as JSON and returns the
 * parsed object. Returns `null` when the envelope is malformed or the text
 * is not valid JSON.
 */
function unwrapMcpToolResult(result: unknown): unknown {
	if (!result || typeof result !== "object") return null
	const envelope = result as { content?: unknown }
	const content = envelope.content
	if (!Array.isArray(content) || content.length === 0) return null
	const first = content[0]
	if (!first || typeof first !== "object") return null
	const text = (first as { text?: unknown }).text
	if (typeof text !== "string") return null
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

export default function ideAdapterExtension(pi: ExtensionAPI): void {
	let connection: IdeConnection | null = null
	let pollTimer: ReturnType<typeof setInterval> | null = null
	let isShuttingDown = false
	let reconnectRetries = 0

	// Per-instance mutable state (isolated from other sessions/agents)
	let pendingAtMentions: AtMentionNotification[] = []
	let _latestSelection: SelectionChangedNotification | null = null
	let currentCtx: ExtensionContext | null = null

	function ensureMaxMentions(): void {
		if (pendingAtMentions.length > MAX_PENDING_MENTIONS) {
			pendingAtMentions = pendingAtMentions.slice(-MAX_PENDING_MENTIONS)
		}
	}

	function localQueueAtMention(mention: AtMentionNotification): void {
		pendingAtMentions.push(mention)
		ensureMaxMentions()
	}

	function localDrainAtMentions(): string[] {
		const formatted = pendingAtMentions.map(formatAtMention)
		pendingAtMentions = []
		return formatted
	}

	function localHasPendingAtMentions(): boolean {
		return pendingAtMentions.length > 0
	}

	function localSetLatestSelection(selection: SelectionChangedNotification): void {
		_latestSelection = selection
	}

	async function discoverAndConnect(cwd: string): Promise<void> {
		if (isShuttingDown) return
		if (connection) return

		const dir = getLockfileDir()
		const lockfilePaths = scanLockfiles(dir)
		const lockfiles = lockfilePaths.map(parseLockfile).filter((l) => l !== null)
		if (lockfiles.length === 0) return

		const match = findMatchingLockfile(lockfiles, cwd)
		if (!match) return

		try {
			const newConnection = await connectToIde(match)
			if (isShuttingDown) {
				await newConnection.close()
				return
			}
			connection = newConnection
			reconnectRetries = 0
		} catch (err) {
			reconnectRetries++
			console.warn(
				`[ide-adapter] Failed to connect to ${match.ideName} (attempt ${reconnectRetries}/${MAX_RECONNECT_RETRIES}):`,
				err,
			)
			if (reconnectRetries >= MAX_RECONNECT_RETRIES) {
				console.warn(
					`[ide-adapter] Max reconnect retries (${MAX_RECONNECT_RETRIES}) reached. Stopping discovery polling.`,
				)
				if (pollTimer) {
					clearInterval(pollTimer)
					pollTimer = null
				}
			}
			return
		}

		// Wire disconnect callback so we can null the handle and reconnect later
		connection.onDisconnect = () => {
			connection = null
		}

		try {
			const tools = await connection.listTools()
			for (const tool of tools) {
				if (isShuttingDown) break
				registerIdeTool(pi, tool)
			}
		} catch (err) {
			console.warn("[ide-adapter] Failed to list IDE tools:", err)
		}

		connection.setNotificationHandler((msg) => {
			dispatchNotification(msg)
		})
	}

	function registerIdeTool(pi: ExtensionAPI, tool: IdeTool): void {
		pi.registerTool({
			name: `ide_${tool.name}`,
			label: `IDE: ${tool.name}`,
			description: tool.description || `IDE tool: ${tool.name}`,
			parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema || { type: "object", properties: {} }),
			execute: async (_toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate, _ctx) => {
				if (signal?.aborted) {
					return {
						content: [{ type: "text" as const, text: "Tool call aborted" }],
						details: { error: "aborted" },
					}
				}
				if (!connection) {
					return {
						content: [{ type: "text" as const, text: "IDE connection lost" }],
						details: { error: "IDE connection lost" },
					}
				}
				try {
					const result = await connection.callTool(tool.name, params)
					if (signal?.aborted) {
						return {
							content: [{ type: "text" as const, text: "Tool call aborted" }],
							details: { error: "aborted" },
						}
					}
					return {
						content: [{ type: "text" as const, text: JSON.stringify(result) }],
						details: result,
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err)
					return {
						content: [{ type: "text" as const, text: `IDE tool error: ${message}` }],
						details: { error: message },
					}
				}
			},
		})
	}

	function dispatchNotification(msg: unknown): void {
		if (typeof msg !== "object" || msg === null) return
		const m = msg as Record<string, unknown>
		if (m.method !== "at_mentioned" && m.method !== "selection_changed") return
		if (typeof m.params !== "object" || m.params === null) return
		const params = m.params as Record<string, unknown>

		if (m.method === "at_mentioned") {
			if (typeof params.filePath === "string") {
				const filePath = currentCtx?.cwd
					? relative(currentCtx.cwd, params.filePath).replace(/\\/g, "/")
					: params.filePath
				const mention: AtMentionNotification = {
					filePath,
					lineStart: typeof params.lineStart === "number" ? params.lineStart : 0,
					lineEnd: typeof params.lineEnd === "number" ? params.lineEnd : 0,
				}
				if (currentCtx?.hasUI) {
					try {
						currentCtx.ui.pasteToEditor(formatAtMention(mention))
						// Force an immediate TUI render so the pasted text appears
						// without waiting for the next user input event.
						currentCtx.ui.setStatus("ide-adapter-mention", undefined)
					} catch {
						// If paste fails (e.g. no active editor), fall back to queue
						localQueueAtMention(mention)
					}
				} else {
					localQueueAtMention(mention)
				}
			}
		} else if (m.method === "selection_changed") {
			if (typeof params.filePath === "string") {
				// Relative-ize the path (matches `at_mentioned`) so the chip shows a
				// short project-relative `@file:range`, not an absolute path.
				const filePath = currentCtx?.cwd
					? relative(currentCtx.cwd, params.filePath).replace(/\\/g, "/")
					: params.filePath
				const selection: SelectionChangedNotification = {
					filePath,
					lineStart: typeof params.lineStart === "number" ? params.lineStart : 0,
					lineEnd: typeof params.lineEnd === "number" ? params.lineEnd : 0,
				}
				localSetLatestSelection(selection)
				// Surface as a right-aligned indicator inside the input box's top
				// border — a dedicated segment alongside (not replacing) the pending
				// image indicator. The selection is also kept sticky in
				// `_latestSelection` for auto-attach on send (see `pi.on('input')`).
				if (currentCtx?.hasUI) {
					setIdeSelectionIndicator(formatAtMention(selection))
				}
			}
		}
	}

	function disconnect(): void {
		// Guard against timer leak if session_start fires multiple times
		if (pollTimer) {
			clearInterval(pollTimer)
			pollTimer = null
		}
		if (connection) {
			// Prevent onDisconnect from clearing a stale handle after we intentionally close
			const conn = connection
			connection = null
			conn.close().catch((err) => console.warn("[ide-adapter] Disconnect error:", err))
		}
	}

	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName
		if (!toolName || !APPROVAL_GATED_TOOLS.has(toolName)) return undefined

		// Approval-gate config: ON by default. Loading once per call is cheap
		// (config.json read) and picks up user toggles without a session restart.
		let ideApproval = true
		try {
			ideApproval = loadConfig({ cwd: ctx.cwd }).ideApproval
		} catch {
			// If config read fails, fall back to the safe default (approval on).
		}
		if (!ideApproval) return undefined

		// No IDE connected → fall back to unguarded writes with a one-line warning.
		// Never deadlock the agent on infrastructure absence.
		if (!connection) {
			console.warn("[ide-adapter] IDE not connected; skipping approval for", toolName)
			return undefined
		}

		const input = (event.input ?? {}) as Record<string, unknown>
		const proposed = computeProposedChange(toolName, input, ctx.cwd)
		if (!proposed) {
			// Malformed inputs (e.g. edit oldText not found) — defer to the tool's
			// own validation surface. Don't block; let the tool fail with its own
			// error message.
			return undefined
		}

		const changeId = generateChangeId()
		const approved = await requestIdeApproval(connection, { ...proposed, changeId }, ctx.signal)
		if (approved === null) {
			// IDE call failed — best-effort approval, fall through.
			console.warn(`[ide-adapter] proposeChange call failed for ${proposed.filePath}; letting ${toolName} proceed`)
			return undefined
		}
		if (!approved) {
			return {
				block: true,
				reason: `User rejected the proposed change to ${proposed.filePath} in the IDE diff viewer.`,
			}
		}
		return undefined
	})

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		currentCtx = ctx
		const cwd = ctx.cwd
		isShuttingDown = false
		reconnectRetries = 0

		// Prevent duplicate poll timers on reconnect
		if (pollTimer) {
			clearInterval(pollTimer)
			pollTimer = null
		}

		discoverAndConnect(cwd).catch((err) => console.warn("[ide-adapter] Discovery error:", err))

		pollTimer = setInterval(() => {
			discoverAndConnect(cwd).catch((err) => console.warn("[ide-adapter] Polling discovery error:", err))
		}, POLL_INTERVAL_MS)
	})

	pi.on("input", (event) => {
		// Drain pending at-mentions (manual Cmd+Option+K path). Empty if none queued.
		const mentions = localHasPendingAtMentions() ? localDrainAtMentions() : []

		// Auto-attach the current IDE selection (sticky). The selection is NOT
		// consumed — it stays "in sync" with the IDE so every send re-attaches
		// whatever is currently selected, until a new selection_changed overwrites it.
		const selectionMention = _latestSelection ? formatAtMention(_latestSelection) : null

		// Dedup: if the user explicitly at-mentioned the same range they have
		// selected (e.g. Cmd+Option+K on the active selection), don't double-prefix.
		const selectionPrefix = selectionMention && !mentions.includes(selectionMention) ? selectionMention : null

		const prefixes = selectionPrefix ? [...mentions, selectionPrefix] : mentions
		if (prefixes.length === 0) return

		const prefix = prefixes.join(" ")
		const text = event.text.trimStart()
		const newText = text ? `${prefix} ${text}` : prefix

		return { action: "transform" as const, text: newText }
	})

	pi.on("session_shutdown", () => {
		currentCtx = null
		isShuttingDown = true
		// Clear the input-box selection indicator so it doesn't persist into
		// the next session (the PromptEditor instance is reused).
		setIdeSelectionIndicator(null)
		disconnect()
	})
}
