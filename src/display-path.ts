import { homedir } from "node:os";
import nodePath from "node:path";

let currentHomePath = homedir();

/**
 * Replaces the home directory used by {@link displayHomePath}. Tests substitute
 * the real value here because `os.homedir()` reads platform-specific
 * environment variables (`HOME` on POSIX, `USERPROFILE` on Windows) and cannot
 * be faked portably by tests.
 */
export function setHomePath(value: string): void {
	currentHomePath = value;
}

/** Current home directory value; mainly for test stubbing. */
export function getHomePath(): string {
	return currentHomePath;
}

/** Formats a filesystem path for stable, cross-platform UI display. */
export function toDisplayPath(value: string, separator: string = nodePath.sep): string {
	return value.replaceAll(separator, "/");
}

/** Path of `target` below `base`, or undefined when it lies outside `base`. */
export function displayPathWithin(base: string, target: string): string | undefined {
	const relativePath = nodePath.relative(base, target);
	if (relativePath === "") return ".";
	if (
		nodePath.isAbsolute(relativePath) ||
		relativePath === ".." ||
		relativePath.startsWith(`..${nodePath.sep}`)
	) {
		return undefined;
	}
	return toDisplayPath(relativePath);
}

/** Abbreviates the user's home directory to `~`. */
export function displayHomePath(path: string): string {
	const home = currentHomePath;
	const withinHome = home ? displayPathWithin(nodePath.resolve(home), nodePath.resolve(path)) : undefined;
	if (withinHome === undefined) return toDisplayPath(path);
	return withinHome === "." ? "~" : `~/${withinHome}`;
}
