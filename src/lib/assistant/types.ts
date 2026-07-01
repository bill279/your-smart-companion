// Provider-agnostic assistant types. Kept in a client-safe module so both
// the frontend and server functions can reference them.

export type InteractionMode = "text" | "push_to_talk" | "continuous";
export type VoiceProvider = "elevenlabs" | "openai_realtime" | "none";
export type ModelProvider = "openai";
export type CostMode = "economy" | "balanced" | "premium";

export type AssistantSettings = {
  interaction_mode: InteractionMode;
  voice_provider: VoiceProvider;
  model_provider: ModelProvider;
  cost_mode: CostMode;
  max_voice_seconds: number;
  require_approval: boolean;
  require_citations: boolean;
};

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  interaction_mode: "text",
  voice_provider: "elevenlabs",
  model_provider: "openai",
  cost_mode: "balanced",
  max_voice_seconds: 45,
  require_approval: true,
  require_citations: true,
};

// Structured envelope the orchestrator aims to return. Not all fields are
// populated in every response; the streaming chat surface still ships
// Markdown today and the envelope pieces are surfaced opportunistically.

export type Citation = {
  title: string;
  url: string;
  snippet?: string;
};

export type TableData = {
  title?: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
};

export type GeneratedFile = {
  name: string;
  mimeType: string;
  url: string;
  sizeBytes?: number;
};

export type ApprovalActionKind =
  | "send_email"
  | "forward_email"
  | "create_calendar_event"
  | "delete_file"
  | "overwrite_file"
  | "submit_form"
  | "purchase";

export type ApprovalAction = {
  id: string;
  kind: ApprovalActionKind;
  title: string;
  details: string;
  recipient?: string;
  draft?: string;
  payload: Record<string, unknown>;
};

export type AssistantUsage = {
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  model?: string;
};

export type AssistantEnvelope = {
  spokenSummary: string;
  displayAnswer: string;
  citations: Citation[];
  tableData?: TableData;
  files?: GeneratedFile[];
  pendingApprovalAction?: ApprovalAction;
  usage?: AssistantUsage;
};

// Tool registry contract. `execute` runs server-side; when
// `needsApproval` is true the orchestrator emits a pendingApprovalAction
// instead of executing directly.
export type ToolDefinition<Input = unknown, Output = unknown> = {
  name: string;
  description: string;
  needsApproval: boolean;
  inputSchema: unknown; // zod schema at runtime
  execute: (input: Input, ctx: { userId: string }) => Promise<Output>;
};

// Cost mode → model id used by the orchestrator.
export const MODEL_FOR_COST_MODE: Record<CostMode, string> = {
  economy: "openai/gpt-5-nano",
  balanced: "openai/gpt-5-mini",
  premium: "openai/gpt-5",
};