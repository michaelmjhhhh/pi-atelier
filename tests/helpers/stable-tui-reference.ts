import type { TUI } from "@earendil-works/pi-tui";

/** Mirrors Pi 0.84's stable reference across active renderer replacements. */
export function stableTuiReference(getRenderer: () => TUI): TUI {
	return new Proxy({} as TUI, {
		get: (_target, property) => {
			const renderer = getRenderer();
			const value = Reflect.get(renderer, property, renderer);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const currentRenderer = getRenderer();
				const method = Reflect.get(currentRenderer, property, currentRenderer);
				if (typeof method !== "function") throw new TypeError(`${String(property)} is not callable`);
				return Reflect.apply(method, currentRenderer, args);
			};
		},
		set: (_target, property, value) => {
			const renderer = getRenderer();
			return Reflect.set(renderer, property, value, renderer);
		},
		has: (_target, property) => Reflect.has(getRenderer(), property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getRenderer()),
	}) as TUI;
}
