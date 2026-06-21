export type DecisionLabelSlot = "1" | "2" | "3";

export interface UpdateDecisionLabelRequest {
  buildId: string;
  branchId: string;
  slot: DecisionLabelSlot;
  label: string;
}

export interface UpdateDecisionLabelResponse {
  ok: boolean;
  error?: string;
  buildId?: string;
  branchId?: string;
  slot?: DecisionLabelSlot;
  label?: string;
  targetFile?: string;
}
