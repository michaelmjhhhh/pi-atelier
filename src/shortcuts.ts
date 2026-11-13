import { DEFAULT_CONFIG } from "./config.js";
import type { AtelierConfig } from "./types.js";

/** Pi matches modifiers in any order, so `shift+ctrl+r` and `ctrl+shift+r` are the same key. */
export const keyIdentity = (key: string): string => {
	const parts = key.toLowerCase().split("+");
	const last = parts.pop() ?? "";
	return [...parts.sort(), last].join("+");
};

export const isReservedShortcut = (shortcut: string, reservedKeys: readonly string[]): boolean => {
	const identity = keyIdentity(shortcut);
	return reservedKeys.some((key) => keyIdentity(key) === identity);
};

/** Keys registered from config, on top of the default open key that is bound at load time. */
export interface ShortcutPlan {
	/** Extra open key; undefined when `shortcut` is the default. */
	open: string | undefined;
	/** Resize key; undefined when every candidate collides with an open key. */
	resize: string | undefined;
	toggle: string | undefined;
	warnings: string[];
}

/**
 * Pi cannot unregister a key, and any key Atelier registers competes with other
 * extensions, so only the resize key the config selects is bound, never the default too.
 */
export function planShortcuts(
	config: Pick<AtelierConfig, "shortcut" | "resizeShortcut" | "toggleShortcut">,
): ShortcutPlan {
	const warnings: string[] = [];
	const defaultOpen = DEFAULT_CONFIG.shortcut;
	const defaultResize = DEFAULT_CONFIG.resizeShortcut;
	const open = isReservedShortcut(config.shortcut, [defaultOpen]) ? undefined : config.shortcut;
	const openKeys = [defaultOpen, config.shortcut];

	let resize: string | undefined = config.resizeShortcut;
	if (isReservedShortcut(resize, openKeys)) {
		const fallback = isReservedShortcut(defaultResize, openKeys) ? undefined : defaultResize;
		warnings.push(
			`resizeShortcut "${resize}" is already an Atelier shortcut` +
				(fallback ? `; using ${fallback}` : "; Sidebar resize has no key"),
		);
		resize = fallback;
	}

	let toggle: string | undefined = config.toggleShortcut || undefined;
	if (toggle && isReservedShortcut(toggle, resize ? [...openKeys, resize] : openKeys)) {
		warnings.push(`toggleShortcut "${toggle}" is already an Atelier shortcut`);
		toggle = undefined;
	}
	return { open, resize, toggle, warnings };
}
