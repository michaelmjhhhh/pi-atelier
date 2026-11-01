export type TodoScrollAction = "top" | "next" | "prev" | "page-up" | "page-down";

export function todoActionFromArgs(args: readonly string[]): TodoScrollAction | null {
	if (args.length === 0) return "top";
	if (args.length !== 1 || !["top", "next", "prev", "page-up", "page-down"].includes(args[0]!)) return null;
	return args[0] as TodoScrollAction;
}

export function clampTodoOffset(offset: number, itemCount: number): number {
	return Math.max(0, Math.min(Math.max(0, itemCount - 1), offset));
}

export function scrollTodoOffset(offset: number, itemCount: number, action: TodoScrollAction): number {
	const maxOffset = Math.max(0, itemCount - 1);
	const current = clampTodoOffset(offset, itemCount);
	const step =
		action === "next"
			? 1
			: action === "prev"
				? -1
				: action === "page-down"
					? 6
					: action === "page-up"
						? -6
						: 0;
	return action === "top" ? 0 : Math.max(0, Math.min(maxOffset, current + step));
}

export function todoWindow<T>(items: readonly T[], offset: number, size = 6) {
	const start = Math.max(0, Math.min(offset, Math.max(0, items.length - 1)));
	const visible = items.slice(start, start + size);
	return {
		items: visible,
		start,
		position: `${start + 1}/${items.length}`,
		hiddenAbove: start > 0,
		hiddenBelow: start + visible.length < items.length,
	};
}

export function todoWindowSummary(
	done: number,
	total: number,
	window: ReturnType<typeof todoWindow<unknown>>,
): string {
	return total > 6
		? `${done}/${total} · ${window.hiddenAbove ? "↑ " : ""}${window.position}${window.hiddenBelow ? " ↓" : ""}`
		: `${done}/${total}`;
}
