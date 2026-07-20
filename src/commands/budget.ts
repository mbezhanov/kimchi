import type { Theme } from "@earendil-works/pi-coding-agent"
import { formatBudgetBreakdown } from "../extensions/billing/command.js"
import {
	type BillingStatus,
	formatBudgetAmount,
	formatBudgetLimit,
	getBillingStatus,
	getBillingWarnings,
	refreshBillingStatusFromConfig,
} from "../extensions/billing/status.js"

/**
 * `kimchi budget [--json]` — print the authenticated user's account-level
 * billing status to stdout.
 *
 * Default (plain text) reuses the same `formatBudgetBreakdown` renderer as the
 * in-session `/budget` slash command, but with a no-op theme so output is
 * ANSI-free and pipe-safe — this is the form the JetBrains plugin shells out
 * to for its Budget tab.
 *
 * `--json` prints the raw `BillingStatus` as JSON for clients that want to
 * build a native GUI without parsing the table.
 *
 * Exit codes:
 *   0 — success
 *   1 — budget unavailable (no Cast AI endpoint configured, fetch failed)
 *   2 — bad arguments
 */
export async function runBudget(args: string[]): Promise<number> {
	if (args.length > 0 && (args[0] === "--help" || args[0] === "-h")) {
		printUsage()
		return 0
	}

	const json = args.includes("--json") || args.includes("-j")
	const unknown = args.filter((a) => a !== "--json" && a !== "-j")
	if (unknown.length > 0) {
		console.error(`kimchi budget: unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(" ")}`)
		printUsage()
		return 2
	}

	const status = await refreshBillingStatusFromConfig()
	if (!status) {
		if (json) {
			console.log("null")
		} else {
			console.error("Budget information is currently unavailable.")
			console.error("Make sure you are logged in (`kimchi login`) and using a Cast AI endpoint.")
		}
		return 1
	}

	if (json) {
		console.log(JSON.stringify(status, null, 2))
		return 0
	}

	printPlain(status)
	return 0
}

function printPlain(status: BillingStatus): void {
	const theme = plainTheme()

	// Account-level summary (credits / plan) — mirrors the status-line fields.
	const credits =
		status.serverless === false || typeof status.remainingCredits !== "number" ? null : status.remainingCredits
	if (status.plan) console.log(`Plan: ${status.plan}`)
	if (status.isPaidTier !== undefined) console.log(`Paid tier: ${status.isPaidTier}`)
	if (credits !== null) console.log(`Remaining credits: ${formatBudgetAmount(String(credits))}`)
	if (status.creditStatus) console.log(`Credit status: ${status.creditStatus}`)
	if (status.restrictedMode !== undefined) console.log(`Restricted mode: ${status.restrictedMode}`)
	if (status.serverless !== undefined) console.log(`Serverless: ${status.serverless}`)

	// Warnings (low/exhausted credits, budget thresholds).
	const warnings = getBillingWarnings(status)
	if (warnings.length > 0) {
		console.log()
		for (const w of warnings) {
			console.log(`[${w.kind.toUpperCase()}] ${w.message}`)
		}
	}

	// Per-scope budget table — same renderer as /budget, ANSI-stripped.
	if (status.budget) {
		console.log()
		const lines = formatBudgetBreakdown(status.budget, theme)
		for (const line of lines) console.log(line)
	} else {
		// No per-scope budget snapshot — surface a hint so the user knows the
		// absence is expected (vs. a fetch failure, which exits 1 earlier).
		console.log()
		console.log("No budget is configured for this API key owner.")
	}

	console.log()
	console.log(`Updated at: ${status.updatedAt}`)
}

function plainTheme(): Theme {
	// Theme whose color/style accessors are identity fns — yields ANSI-free text.
	// Matches the pattern in extensions/todos/command.ts:plainTheme.
	return { fg: (_color: string, text: string) => text } as Theme
}

function printUsage(): void {
	console.error("Usage: kimchi budget [--json]")
	console.error("       kimchi budget            # print budget breakdown as plain text")
	console.error("       kimchi budget --json      # print BillingStatus as JSON")
	console.error("       kimchi budget --help      # show this help")
}

// Re-exported so the JetBrains plugin (or other callers) can import the same
// types/labels if it ever moves off the shell-out to a library call.
export { formatBudgetLimit, getBillingStatus }
