export const keyIdentity = (key: string): string => {
	const parts = key.toLowerCase().split("+");
	const last = parts.pop() ?? "";
	return [...parts.sort(), last].join("+");
};

export const isReservedShortcut = (shortcut: string, reservedKeys: readonly string[]): boolean => {
	const identity = keyIdentity(shortcut);
	return reservedKeys.some((key) => keyIdentity(key) === identity);
};
