/** Session lifetime shared by every interactive overlay owned by the extension. */
export interface OverlayLifetime {
	isActive(): boolean;
	register(cancel: () => void): () => void;
}

/** Resolves an extension-side overlay operation independently from the host callback. */
export interface OverlaySettlement<T> {
	readonly promise: Promise<T>;
	settle(value: T): void;
}

export function createOverlaySettlement<T>(): OverlaySettlement<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	let settled = false;
	return {
		promise,
		settle(value) {
			if (settled) return;
			settled = true;
			resolve(value);
		},
	};
}

export interface LifecycleOverlayComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

/** Controls the lifetime of a mounted overlay binding. */
export interface RetirableLifecycleOverlayComponent extends LifecycleOverlayComponent {
	/** Retires the binding and invokes the host-removal callback. */
	retire(): void;
	/** Releases the binding without invoking host removal a second time. */
	release(): void;
}

/**
 * Keeps an overlay inert after its session retires, even when Pi cannot remove it.
 * Retirement is best-effort: a host `done()` failure must not make stale render/input
 * paths call into the retired runtime.
 */
export function createLifecycleOverlayComponent(
	lifetime: OverlayLifetime | undefined,
	component: LifecycleOverlayComponent,
	retire: () => void,
): RetirableLifecycleOverlayComponent {
	let inert = false;
	let activeComponent: LifecycleOverlayComponent | undefined = component;
	let unregisterLifetime: (() => void) | undefined;
	const isActive = (): boolean => {
		if (inert) return false;
		try {
			return lifetime?.isActive() ?? true;
		} catch {
			return false;
		}
	};
	const releaseSafely = (): boolean => {
		if (inert) return false;
		inert = true;
		activeComponent = undefined;
		const unregister = unregisterLifetime;
		unregisterLifetime = undefined;
		try {
			unregister?.();
		} catch {
			// Lifetime unregister is best-effort during session teardown.
		}
		return true;
	};
	const retireSafely = (): void => {
		if (!releaseSafely()) return;
		try {
			retire();
		} catch {
			// Pi overlay removal is best-effort during session teardown.
		}
	};

	if (lifetime) {
		try {
			unregisterLifetime = lifetime.register(retireSafely);
		} catch {
			retireSafely();
		}
	}

	return {
		retire: retireSafely,
		release: () => {
			releaseSafely();
		},
		render(width) {
			if (!isActive()) {
				retireSafely();
				return [];
			}
			return activeComponent?.render(width) ?? [];
		},
		invalidate() {
			if (!isActive()) {
				retireSafely();
				return;
			}
			activeComponent?.invalidate();
		},
		handleInput(data) {
			if (!isActive()) {
				retireSafely();
				return;
			}
			activeComponent?.handleInput(data);
		},
	};
}
