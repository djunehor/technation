
export type Verdict = 'ENDORSED' | 'NOT ENDORSED' | 'INCONCLUSIVE';

export interface AssessmentCriteria {
  id: string;
  name: string;
  description: string;
  met: boolean;
  justification: string;
  evidenceReference: string[];
}

export interface TechNationAssessment {
  candidateName: string;
  pathway: 'Exceptional Talent' | 'Exceptional Promise';
  mandatoryCriteria: AssessmentCriteria;
  optionalCriteria: AssessmentCriteria[];
  overallVerdict: Verdict;
  summary: string;
  rounds: AssessmentRound[];
}

export interface AssessmentRound {
  roundNumber: number;
  reviewerNotes: string;
  adversaryNotes: string;
  consensusReached: boolean;
  currentVerdict: Verdict;
}

export interface AgentResponse {
  verdict: Verdict;
  justification: string;
  critique?: string;
  consensusScore: number; // 0 to 1
}
