export type AdvisorType = 'revenue' | 'growth' | 'front-desk' | 'competitor' | 'operations';

export interface AdvisoryDateRange {
  from?: string;
  to?: string;
}

export interface AdvisoryAction {
  label: string;
  path: string;
  description: string;
  primary?: boolean;
  context?: Record<string, unknown>;
}

export interface AdvisorResponse {
  advisorType: AdvisorType;
  answer: string;
  // 'model' when `answer` came from a real LLM through the governed gateway;
  // 'rule-based' when it is the deterministic templated fallback (mock provider,
  // guardrail, PHI-blocked, budget-capped, or provider error).
  answerSource: 'model' | 'rule-based';
  // expectedImpact + confidence are rule-based templated arithmetic over real
  // backend counts, NOT AI-model outputs. This label makes that explicit.
  methodology: string;
  summary: string;
  diagnosis: string;
  recommendedAction: string;
  expectedImpact: number;
  confidence: number;
  evidence: string[];
  recommendations: string[];
  actions: AdvisoryAction[];
  question?: string;
  clinicId?: string | null;
  generatedAt: string;
}

export interface AdvisoryBriefResponse {
  generatedAt: string;
  clinicId?: string | null;
  clinicName?: string | null;
  advisors: AdvisorResponse[];
}

export interface AdvisorAnalysis {
  advisorType: AdvisorType;
  summary: string;
  diagnosis: string;
  recommendedAction: string;
  expectedImpact: number;
  confidence: number;
  evidence: string[];
  recommendations: string[];
  actions: AdvisoryAction[];
}

export interface AdvisorPromptInput {
  advisorType: AdvisorType;
  question?: string;
  analysis: AdvisorAnalysis;
  clinicName?: string | null;
}

export interface AdvisoryRequestInput {
  advisorType: AdvisorType;
  question: string;
  clinicId?: string;
  dateRange?: AdvisoryDateRange;
}

