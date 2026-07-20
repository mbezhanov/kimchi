import { readdirSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { LockfileData } from "./types.js"

const DEFAULT_LOCKFILE_DIR = join(homedir(), ".config", "kimchi", "ide")

export function getLockfileDir(): string {
	return process.env.KIMCHI_IDE_LOCKFILE_DIR ?? DEFAULT_LOCKFILE_DIR
}

/** Return all absolute paths to *.lock files in the lockfile directory. */
export function scanLockfiles(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".lock"))
			.map((f) => join(dir, f))
	} catch {
		return []
	}
}

/** Parse a single lockfile. Returns `null` if malformed or missing required fields. */
export function parseLockfile(path: string): LockfileData | null {
	let raw: string
	try {
		raw = readFileSync(path, "utf-8")
	} catch {
		return null
	}

	let data: unknown
	try {
		data = JSON.parse(raw)
	} catch {
		return null
	}

	if (typeof data !== "object" || data === null) return null

	const d = data as Record<string, unknown>
	if (typeof d.port !== "number") return null
	if (typeof d.pid !== "number") return null
	if (typeof d.authToken !== "string") return null
	if (!Array.isArray(d.workspaceFolders)) return null

	return {
		port: d.port,
		pid: d.pid,
		ideName: typeof d.ideName === "string" ? d.ideName : "unknown",
		ideVersion: typeof d.ideVersion === "string" ? d.ideVersion : "unknown",
		transport: typeof d.transport === "string" ? d.transport : "ws",
		workspaceFolders: d.workspaceFolders.filter((f): f is string => typeof f === "string"),
		authToken: d.authToken,
	}
}

/** Best-effort check whether a process with the given PID is still running. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/** Resolve a path to its canonical (symlink-free) form.
 *
 * IntelliJ's VFS canonicalizes symlinks — `VirtualFile.path` for a file inside
 * a symlinked project root returns the real path, not the symlink the user
 * navigated through. The CLI's `cwd` and the lockfile's `workspaceFolders`
 * (written from `project.basePath`) can be in symlink form. Comparing or
 * relativizing across these two path-spaces produces broken `../`-laden
 * results. This normalizes a path to its canonical form so both sides agree.
 *
 * Falls back to the original path if `realpathSync` fails (e.g. the path
 * doesn't exist on this filesystem — possible in test fixtures or stale
 * lockfiles).
 */
export function realpathSafe(p: string): string {
	try {
		return realpathSync(p)
	} catch {
		return p
	}
}

/** Find a lockfile whose workspaceFolders contains the given cwd.
 *
 * Both `cwd` and each `workspaceFolder` are canonicalized via `realpathSafe`
 * before comparison, so a symlinked project root (e.g. `~/projects/GoProj`
 * → `~/go/src/GoProj`) matches correctly regardless of which form each side
 * is in. Without this, a `===` check fails and `findMatchingLockfile` falls
 * back to `alive[0]`, connecting every kimchi session to the same IDE project
 * instead of matching per-repo.
 *
 * Falls back to any alive lockfile when none matches the cwd.
 */
export function findMatchingLockfile(lockfiles: LockfileData[], cwd: string): LockfileData | undefined {
	const alive = lockfiles.filter((l) => isProcessAlive(l.pid))
	const cwdReal = realpathSafe(cwd).replace(/\\/g, "/")
	const exactMatch = alive.find((l) =>
		l.workspaceFolders.some((wf) => {
			const wfReal = realpathSafe(wf).replace(/\\/g, "/")
			return wfReal === cwdReal || cwdReal.startsWith(`${wfReal}/`)
		}),
	)
	return exactMatch ?? alive[0]
}
