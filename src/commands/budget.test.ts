import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — declared before imports that consume them.
// ---------------------------------------------------------------------------

// refreshBillingStatusFromConfig is the network seam; mock it so tests never
// hit the Cast AI endpoint. Each test seeds the return value via mockResolvedValue.
vi.mock("../extensions/billing/status.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../extensions/billing/status.js")>()
	return {
		...actual,
		refreshBillingStatusFromConfig: vi.fn(),
	}
})

// formatBudgetBreakdown comes from the in-session /budget command module — it
// pulls in pi-coding-agent types. Mock it to return a known line so we don't
// couple these tests to the table renderer's formatting choices.
vi.mock("../extensions/billing/command.js", () => ({
	formatBudgetBreakdown: vi.fn(() => ["<budget-table-line>"]),
}))

import { formatBudgetBreakdown } from "../extensions/billing/command.js"
import {
	type BillingStatus,
	refreshBillingStatusFromConfig,
	setBillingStatusForTest,
} from "../extensions/billing/status.js"
import { runBudget } from "./budget.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatus(overrides?: Partial<BillingStatus>): BillingStatus {
	return {
		serverless: true,
		plan: "coder",
		isPaidTier: true,
		remainingCredits: 42.5,
		creditStatus: "ok",
		restrictedMode: false,
		updatedAt: "2026-07-20T00:00:00.000Z",
		...overrides,
	}
}

// Silence console.log/error during tests; capture output for assertions.
let logs: string[]
let errors: string[]

beforeEach(() => {
	logs = []
	errors = []
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logs.push(args.join(" "))
	})
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args.join(" "))
	})
})

afterEach(() => {
	vi.clearAllMocks()
	setBillingStatusForTest(undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kimchi budget", () => {
	it("returns 2 and prints usage for unknown arguments", async () => {
		const code = await runBudget(["--bogus"])
		expect(code).toBe(2)
		expect(errors.some((e) => e.includes("unknown argument"))).toBe(true)
		expect(errors.some((e) => e.includes("Usage:"))).toBe(true)
	})

	it("returns 0 and prints usage for --help", async () => {
		const code = await runBudget(["--help"])
		expect(code).toBe(0)
		expect(errors.some((e) => e.includes("Usage:"))).toBe(true)
	})

	it("returns 1 and prints plain message when billing status is unavailable", async () => {
		vi.mocked(refreshBillingStatusFromConfig).mockResolvedValueOnce(undefined)
		const code = await runBudget([])
		expect(code).toBe(1)
		expect(errors.some((e) => e.includes("Budget information is currently unavailable"))).toBe(true)
	})

	it("returns 1 and prints 'null' for --json when billing status is unavailable", async () => {
		vi.mocked(refreshBillingStatusFromConfig).mockResolvedValueOnce(undefined)
		const code = await runBudget(["--json"])
		expect(code).toBe(1)
		expect(logs).toContain("null")
	})

	it("prints plain-text breakdown when status is available", async () => {
		vi.mocked(refreshBillingStatusFromConfig).mockResolvedValueOnce(makeStatus())
		const code = await runBudget([])
		expect(code).toBe(0)
		// Header fields from BillingStatus
		expect(logs.some((l) => l.includes("Plan: coder"))).toBe(true)
		expect(logs.some((l) => l.includes("Remaining credits: $42.50"))).toBe(true)
		expect(logs.some((l) => l.includes("Credit status: ok"))).toBe(true)
		expect(logs.some((l) => l.includes("Updated at: 2026-07-20"))).toBe(true)
		// No budget snapshot in this status → fallback hint
		expect(logs.some((l) => l.includes("No budget is configured"))).toBe(true)
		// formatBudgetBreakdown is NOT called when there's no budget
		expect(formatBudgetBreakdown).not.toHaveBeenCalled()
	})

	it("renders budget table when budget snapshot is present", async () => {
		const status = makeStatus({
			budget: {
				period: { startTime: "2026-07-01T00:00:00.000Z", endTime: "2026-07-31T23:59:59.999Z" },
				budgets: [
					{
						scope: "USER",
						scopeId: "user-1",
						budgetLimitUsd: "100",
						totalSpendUsd: "12.34",
						providerBudgets: [],
					},
				],
			},
		})
		vi.mocked(refreshBillingStatusFromConfig).mockResolvedValueOnce(status)
		const code = await runBudget([])
		expect(code).toBe(0)
		expect(formatBudgetBreakdown).toHaveBeenCalledTimes(1)
		expect(formatBudgetBreakdown).toHaveBeenCalledWith(status.budget, expect.anything())
		expect(logs.some((l) => l.includes("<budget-table-line>"))).toBe(true)
	})

	it("prints warnings (low/exhausted) when present", async () => {
		const status = makeStatus({ creditStatus: "low", remainingCredits: 3 })
		vi.mocked(refreshBillingStatusFromConfig).mockResolvedValueOnce(status)
		const code = await runBudget([])
		expect(code).toBe(0)
		expect(logs.some((l) => /\[LOW\]/.test(l))).toBe(true)
	})

	it("prints valid JSON for --json when status is available", async () => {
		const status = makeStatus({ serverless: false })
		vi.mocked(refreshBillingStatusFromConfig).mockResolvedValueOnce(status)
		const code = await runBudget(["--json"])
		expect(code).toBe(0)
		expect(logs).toHaveLength(1)
		const parsed = JSON.parse(logs[0])
		expect(parsed).toMatchObject({ plan: "coder", isPaidTier: true })
	})

	it("does not call refreshBillingStatusFromConfig for --help", async () => {
		const code = await runBudget(["--help"])
		expect(code).toBe(0)
		expect(refreshBillingStatusFromConfig).not.toHaveBeenCalled()
	})
})
