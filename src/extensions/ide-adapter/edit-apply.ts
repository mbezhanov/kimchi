/**
 * Apply a sequence of edit operations to a file's current content, producing
 * the resulting content that the agent's `edit` tool would write to disk.
 *
 * Used by the ide-adapter `tool_call` hook to compute the proposed `newContent`
 * to send to the IDE's diff viewer *before* the agent's edit tool runs. This
 * lets the user preview the cumulative effect of all operations in one diff.
 *
 * Semantics mirror `getEditOperations` + the agent's `edit` tool:
 *   - Each operation replaces the first occurrence of `oldText` with `newText`.
 *   - Operations are applied sequentially in array order.
 *   - If any `oldText` is not found in the (possibly already-mutated) content,
 *     the function returns `null`. In that case the hook defers to the edit
 *     tool's own validation surface rather than duplicating the error message.
 *
 * This deliberately does NOT implement fuzzy/whitespace-tolerant matching —
 * the agent's edit tool is exact-match, so the diff preview must be too.
 */

export interface EditOperation {
	oldText: string
	newText: string
}

/**
 * Normalise the raw `edit` tool input into a list of edit operations.
 *
 * Accepts both the array form (`edits: [{oldText, newText}, ...]`) and the
 * single-operation form (`{oldText, newText}` at the top level), with
 * `old_text`/`new_text` snake_case fallbacks for OpenAI-style callers.
 * Filters out empty `oldText` and no-op (`oldText === newText`) entries,
 * matching `getEditOperations` in `src/extensions/tool-rendering.ts:2264`.
 */
export function normaliseEditOperations(input: {
	oldText?: string
	old_text?: string
	newText?: string
	new_text?: string
	edits?: Array<{ oldText?: string; old_text?: string; newText?: string; new_text?: string }>
}): Array<EditOperation> {
	if (Array.isArray(input?.edits)) {
		return input.edits
			.map((edit) => ({
				oldText:
					typeof edit?.oldText === "string" ? edit.oldText : typeof edit?.old_text === "string" ? edit.old_text : "",
				newText:
					typeof edit?.newText === "string" ? edit.newText : typeof edit?.new_text === "string" ? edit.new_text : "",
			}))
			.filter((edit) => edit.oldText && edit.oldText !== edit.newText)
	}
	const oldText =
		typeof input?.oldText === "string" ? input.oldText : typeof input?.old_text === "string" ? input.old_text : ""
	const newText =
		typeof input?.newText === "string" ? input.newText : typeof input?.new_text === "string" ? input.new_text : ""
	return oldText && oldText !== newText ? [{ oldText, newText }] : []
}

/**
 * Apply operations sequentially to `original`, returning the resulting content.
 *
 * Returns `null` if any `oldText` is not found in the content at the point
 * where its operation is applied. This matches the agent's `edit` tool, which
 * fails the whole call if any `oldText` is missing — we surface that failure
 * by letting the tool's own validation handle it (the hook returns
 * `{ block: false }` so the tool runs and reports the error itself).
 *
 * Each operation replaces the **first** occurrence only, matching the agent's
 * `edit` tool. Callers that need all-occurrences replacement should split
 * that into multiple explicit operations.
 */
export function applyEdits(original: string, operations: Array<EditOperation>): string | null {
	let content = original
	for (const op of operations) {
		const idx = content.indexOf(op.oldText)
		if (idx === -1) return null
		content = content.slice(0, idx) + op.newText + content.slice(idx + op.oldText.length)
	}
	return content
}

/**
 * Convenience: normalise the raw `edit` input and apply it in one call.
 * Returns `null` if any operation's `oldText` is not found.
 */
export function applyEditInput(original: string, input: Parameters<typeof normaliseEditOperations>[0]): string | null {
	return applyEdits(original, normaliseEditOperations(input))
}
