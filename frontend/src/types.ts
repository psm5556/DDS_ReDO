export type Role = "owner" | "editor" | "runner" | "viewer";
export type Surrogate = "gp" | "tabpfn";

export interface User {
  id: number; user_key: string; name: string; email?: string | null;
  department?: string | null; department_id?: number | null;
  business_unit?: string | null; business_unit_id?: number | null; system_role: string;
}
export interface FactorDef { key: string; name: string; unit: string; low: number; high: number; step: number; scale: "linear" | "log"; }
export interface ResponseDef {
  key: string; name: string; unit: string; goal: "maximize" | "minimize" | "target";
  target?: number | null; lsl?: number | null; usl?: number | null;
  input_min?: number | null; input_max?: number | null; decimals: number;
}
export interface ProjectSettings {
  mode: "explore" | "optimize" | "robust"; robust_objective: "spec_prob" | "taguchi" | "mean_k_sigma"; k_sigma: number;
  batch_size: number; budget_runs: number; default_surrogate: Surrogate; design_method: "sobol" | "lhs";
  initial_points?: number | null; replicate_fraction: number; replicates_per_point: number; primary_response?: string | null;
}
export interface ProjectConfig { factors: FactorDef[]; responses: ResponseDef[]; settings: ProjectSettings; }
export interface ProjectSummary {
  id: number; name: string; description: string; status: string; tags: string[]; owner: User;
  business_unit?: string | null; my_role: Role; runs_total: number; runs_done: number; runs_open: number;
  batches: number; updated_at: string; deleted_at?: string | null; primary_response?: string | null;
}
export interface ProjectDetail extends ProjectSummary { config: ProjectConfig; warnings: string[]; }
export interface Batch {
  id: number; seq: number; kind: string; surrogate?: string | null; acquisition: Record<string, unknown>;
  note: string; created_at: string; created_by: string; runs_total: number; runs_done: number;
}
export type RunStatus = "planned" | "running" | "done" | "failed" | "infeasible" | "excluded";
export interface Run {
  id: number; batch_id: number; batch_seq: number; code: string; replicate_no: number; run_order: number;
  is_replicate_of_existing: boolean; status: RunStatus; planned: Record<string, number>; actual: Record<string, number>;
  fail_reason: string; deviation_note: string; reason: string; values: Record<string, number | null>;
  excluded: Record<string, boolean>; notes: Record<string, string>; updated_at: string;
}
export interface Best {
  x: Record<string, number>; mean: number; mean_lo: number; mean_hi: number; sigma: number; sigma_lo: number; sigma_hi: number;
  obs_lo: number; obs_hi: number; spec_prob: number | null; expected_score: number; score_label: string;
  extrapolation: boolean; already_tested: boolean; objective: string;
}
export interface Validation {
  available: boolean; message?: string; method?: string; rmse?: number; rmse_relative?: number; coverage95?: number;
  crps?: number; observed?: number[]; predicted?: number[]; status?: string; messages?: string[];
}
export interface AnalysisResult {
  response_key: string; surrogate: Surrogate; surrogate_version: string;
  data: { n_points: number; n_obs: number; n_replicated_points: number };
  objective: string; objective_kind: string; best: Best; best_is_tentative: boolean; validation: Validation | null;
  variance_reliability: "ok" | "low" | "none"; decomposition_is_approximate: boolean; warnings: string[];
  data_hash: string; elapsed_sec?: number; pending_runs?: number; model_version_id?: number;
}
export interface Surface {
  x: { key: string; name: string; unit: string; values: number[] }; y: { key: string; name: string; unit: string; values: number[] };
  fixed: Record<string, number>; mean: number[][]; sigma: number[][]; epistemic_sd: number[][]; spec_prob: number[][] | null;
  points: { x: number; y: number; n?: number; mean?: number }[]; decomposition_is_approximate: boolean; variance_reliability: string;
}
export interface Effect { key: string; name: string; unit: string; x: number[]; mean: number[]; lo: number[]; hi: number[]; sigma: number[]; }
export interface Prediction {
  x: Record<string, number>; mean: number; mean_lo: number; mean_hi: number; sigma: number; sigma_lo: number; sigma_hi: number;
  epistemic_sd: number; obs_lo: number; obs_hi: number; spec_prob: number | null; extrapolation?: boolean;
}
export interface Proposal {
  x: Record<string, number>; kind: "new" | "replicate"; reason_type: "explore" | "exploit" | "replicate"; reason: string;
  acquisition: number; mean: number; mean_lo: number; mean_hi: number; sigma: number; sigma_lo: number; sigma_hi: number;
  spec_prob: number | null; expected_score: number; extrapolation: boolean;
}
export interface RecommendResult {
  response_key: string; surrogate: Surrogate; surrogate_version: string; objective: string; mode: string; objective_kind: string;
  incumbent: number; pool_size: number; notes: string[]; proposals: Proposal[]; elapsed_sec: number; pending_runs: number;
  decomposition_is_approximate: boolean;
}
export interface SurrogateInfo { name: Surrogate; label: string; available: boolean; experimental: boolean; status: string; }
export interface Share {
  id: number; token: string; project_id: number; project_name: string; target_type: string; target_id: number | null;
  target_label: string; permission: "view" | "view_simulate"; mode: "snapshot" | "live"; response_key: string;
  surrogate: Surrogate; include_raw: boolean; expires_at: string | null; created_at: string; created_by: string;
  revoked_at: string | null; view_count: number;
}
export interface Member { user: User; role: Role; }
export interface OpenRun { project_id: number; project_name: string; run: Run; factors: FactorDef[]; my_role: Role; }
