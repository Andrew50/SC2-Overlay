export interface SetBranchDisabledRequest {
  buildId: string;
  branchId: string;
  disabled: boolean;
}

export interface SetBranchDisabledResponse {
  ok: boolean;
  error?: string;
  buildId?: string;
  branchId?: string;
  disabled?: boolean;
  targetFile?: string;
}
