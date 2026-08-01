import type { GoalStateEntryData, PiGoalStatePayload, PiGoalStatus } from "../../src/types.js";

/** Canonical customType for goal-state session entries. */
export const GOAL_CUSTOM_TYPE = "goal-state";

/** All valid goal statuses — must stay in sync with PiGoalStatus type. */
export const VALID_STATUSES: readonly PiGoalStatus[] = [
	"active",
	"queued",
	"paused",
	"blocked",
	"usage_limited",
	"budget_limited",
	"complete",
	"cleared",
] as const;

/** Statuses that should NOT be reconstructed from session entries. */
export const NON_RECONSTRUCTABLE_STATUSES = ["complete"] as const;

/**
 * Create a typed `pi-goal:state` event payload.
 */
export function goalPayload(opts?: { goalId?: string; text?: string; status?: string }): PiGoalStatePayload {
	return {
		goalId: opts?.goalId ?? "g-test",
		text: opts?.text ?? "Test goal",
		status: opts?.status ?? "active",
	};
}

/**
 * Create a typed session custom entry for goal-state persistence.
 */
export function goalSessionEntry(opts?: { id?: string; text?: string; status?: string | null }): {
	type: "custom";
	customType: typeof GOAL_CUSTOM_TYPE;
	data: GoalStateEntryData;
} {
	if (opts?.status === null) {
		return {
			type: "custom",
			customType: GOAL_CUSTOM_TYPE,
			data: { goal: null },
		};
	}
	return {
		type: "custom",
		customType: GOAL_CUSTOM_TYPE,
		data: {
			goal: {
				id: opts?.id ?? "g-entry",
				text: opts?.text ?? "Entry goal",
				status: opts?.status ?? "active",
			},
		},
	};
}

/**
 * Create an incomplete/missing-fields session entry.
 */
export function incompleteGoalEntry(opts?: { id?: boolean; text?: boolean; status?: boolean }): {
	type: "custom";
	customType: typeof GOAL_CUSTOM_TYPE;
	data: GoalStateEntryData;
} {
	const goalObj: Record<string, string> = {};
	if (opts?.id) goalObj.id = "g-incomplete";
	if (opts?.text) goalObj.text = "Incomplete";
	if (opts?.status) goalObj.status = "active";
	return {
		type: "custom",
		customType: GOAL_CUSTOM_TYPE,
		data: { goal: goalObj as GoalStateEntryData["goal"] },
	};
}
