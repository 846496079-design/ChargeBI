export type WorkflowStep = {
  step: string;
  status: "completed" | "running" | "pending";
};

export type Kpi = {
  label: string;
  value: string;
  delta?: string;
};

export type ChartSpec = {
  type: "bar" | "line" | "table" | "forecast" | "comparison" | "pie" | "bubble";
  title: string;
  xKey: string;
  yKey: string;
  data: Record<string, unknown>[];
  seriesKeys?: string[];
  sizeKey?: string;
};

export type TrustInfo = {
  modelTrace?: {
    provider: string;
    configured: boolean;
    called: boolean;
    ok: boolean;
    status?: number;
    latencyMs?: number;
    error?: string;
  };
  schemaMatches: {
    table: string;
    fields: string[];
    reason: string;
    confidence: number;
  }[];
  sql: string;
  guardResult: string;
};

export type AnswerBlock = {
  title: string;
  summary?: string;
  kpis?: Kpi[];
  chart: ChartSpec | null;
  table: {
    columns: string[];
    rows: Record<string, unknown>[];
  };
};

export type QueryResponse = {
  type: "answer" | "clarification" | "blocked" | "error";
  understanding: {
    intent: string;
    interpretedQuestion: string;
    timeRange?: string;
    metrics?: string[];
    dimensions?: string[];
    filters?: string[];
  };
  workflow: WorkflowStep[];
  answer: {
    summary: string;
    kpis: Kpi[];
    chart: ChartSpec | null;
    table: {
      columns: string[];
      rows: Record<string, unknown>[];
    };
    blocks?: AnswerBlock[];
    mapHighlight: {
      regionIds?: string[];
      stationIds?: string[];
    };
    followUps: string[];
  };
  trust: TrustInfo;
  nextContext: Record<string, unknown>;
};
