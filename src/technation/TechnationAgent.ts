
import { getLLMProvider } from '../llm/ProviderFactory.js';
import type { LLMProvider } from '../types/index.js';
import { REVIEWER_SYSTEM_PROMPT, ADVERSARY_SYSTEM_PROMPT, JUDGE_SYSTEM_PROMPT } from './prompts.js';
import type { TechNationAssessment } from './types.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CACHE_DIR = 'scratch/agent_cache';
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

export class TechnationAgent {
  private reviewer: LLMProvider;
  private adversary: LLMProvider;
  private judge: LLMProvider;
  private guidesContent: string = '';

  constructor() {
    this.reviewer = getLLMProvider();
    this.adversary = getLLMProvider();
    this.judge = getLLMProvider();
  }

  async initialize() {
    const guidesPath = 'scratch/technation_text';
    const files = [
      'Tech Nation - Global Talent Visa Application Guide.txt',
      'Tech Nation Internal Assessor Guide.txt'
    ];

    this.guidesContent = files.map(f => {
      const content = fs.readFileSync(path.join(guidesPath, f), 'utf-8');
      return `### GUIDE: ${f}\n${content}\n`;
    }).join('\n');
  }

  private async cachedChat(provider: LLMProvider, messages: any[], tag: string): Promise<string> {
    const hash = crypto.createHash('md5').update(JSON.stringify(messages)).digest('hex');
    const cachePath = path.join(CACHE_DIR, `${tag}_${hash}.txt`);

    if (fs.existsSync(cachePath)) {
      Logger.info(`[CACHE HIT] Loading ${tag} response from cache...`);
      return fs.readFileSync(cachePath, 'utf-8');
    }

    const response = await provider.chat(messages, []);
    const content = response.content || '';
    
    if (content) {
      fs.writeFileSync(cachePath, content);
    }
    return content;
  }

  async assess(candidateName: string, applicationText: string, specifiedPathway?: 'Exceptional Talent' | 'Exceptional Promise', targetCriteria?: string): Promise<TechNationAssessment> {
    Logger.info(`Starting Tech Nation assessment for ${candidateName}`);

    const assessment: TechNationAssessment = {
      candidateName,
      pathway: specifiedPathway || 'Exceptional Talent',
      mandatoryCriteria: { id: 'MC', name: 'Mandatory Criteria', description: '', met: false, justification: '', evidenceReference: [] },
      optionalCriteria: [],
      overallVerdict: 'INCONCLUSIVE',
      summary: '',
      rounds: []
    };

    let currentReviewerNotes = '';
    let currentAdversaryNotes = '';
    let consensusReached = false;
    let roundCount = 0;
    const maxRounds = 5;

    // Initial Review
    Logger.info('Round 0: Initial Review - Checking cache or calling LLM...');
    currentReviewerNotes = await this.cachedChat(this.reviewer, [
      { role: 'system', content: REVIEWER_SYSTEM_PROMPT + '\n\n' + this.guidesContent },
      { role: 'user', content: `Candidate: ${candidateName}\n${specifiedPathway ? `Pathway: ${specifiedPathway}\n` : ''}${targetCriteria ? `Targeted Criteria: ${targetCriteria}\n` : ''}\nApplication Documents:\n${applicationText}\n\nPlease provide your initial assessment. Format your response with clear sections for MC and each OC.` }
    ], 'reviewer_initial');
    Logger.info(`--- INITIAL REVIEW FULL TRANSCRIPT ---\n${currentReviewerNotes}\n`);

    while (!consensusReached && roundCount < maxRounds) {
      roundCount++;
      Logger.info(`Round ${roundCount}: Adversarial Debate`);

      // Adversary's Turn
      Logger.info(`Round ${roundCount}: Adversary's Turn - Checking cache or calling LLM...`);
      currentAdversaryNotes = await this.cachedChat(this.adversary, [
        { role: 'system', content: ADVERSARY_SYSTEM_PROMPT + '\n\n' + this.guidesContent },
        { role: 'user', content: `Reviewer's Assessment:\n${currentReviewerNotes}\n\nCandidate Application:\n${applicationText}\n\nPlease critique the Reviewer's assessment. Be as critical as possible based on the guides.` }
      ], `adversary_r${roundCount}`);
      Logger.info(`--- ADVERSARY CRITIQUE (Round ${roundCount}) ---\n${currentAdversaryNotes}\n`);

      // Reviewer's Rebuttal/Update
      Logger.info(`Round ${roundCount}: Reviewer's Rebuttal - Checking cache or calling LLM...`);
      currentReviewerNotes = await this.cachedChat(this.reviewer, [
        { role: 'system', content: REVIEWER_SYSTEM_PROMPT + '\n\n' + this.guidesContent },
        { role: 'user', content: `Adversary's Critique:\n${currentAdversaryNotes}\n\nCandidate Application:\n${applicationText}\n\nRespond to the critique and provide your updated (and potentially final) assessment.` }
      ], `reviewer_r${roundCount}`);
      Logger.info(`--- REVIEWER UPDATED ASSESSMENT (Round ${roundCount}) ---\n${currentReviewerNotes}\n`);

      // Judge's Evaluation
      Logger.info(`Round ${roundCount}: Judge's Evaluation - Checking cache or calling LLM...`);
      const judgeVerdictText = await this.cachedChat(this.judge, [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT + '\n\n' + this.guidesContent },
        { role: 'user', content: `Reviewer's Assessment:\n${currentReviewerNotes}\n\nAdversary's Critique:\n${currentAdversaryNotes}\n\nHas consensus been reached? If so, what is the final verdict (ENDORSED or NOT ENDORSED)? If not, summarize the remaining points of contention.` }
      ], `judge_r${roundCount}`);

      Logger.info(`--- JUDGE ROUND EVALUATION (Round ${roundCount}) ---\n${judgeVerdictText}\n`);
      consensusReached = judgeVerdictText.includes('CONSENSUS REACHED') || roundCount >= maxRounds;

      assessment.rounds.push({
        roundNumber: roundCount,
        reviewerNotes: currentReviewerNotes,
        adversaryNotes: currentAdversaryNotes,
        consensusReached,
        currentVerdict: judgeVerdictText.includes('ENDORSED') && !judgeVerdictText.includes('NOT ENDORSED') ? 'ENDORSED' : 'NOT ENDORSED'
      });
    }

    // Final Judge verdict with structured parsing
    Logger.info('Final Decision - Checking cache or calling LLM...');
    const finalDecisionText = await this.cachedChat(this.judge, [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT + '\n\n' + this.guidesContent + '\n\nPlease output your final decision in the following JSON format:\n{\n  "overallVerdict": "ENDORSED" | "NOT ENDORSED",\n  "pathway": "Exceptional Talent" | "Exceptional Promise",\n  "summary": "...",\n  "mandatoryCriteria": { "met": boolean, "justification": "..." },\n  "optionalCriteria": [\n    { "name": "OC1", "met": boolean, "justification": "..." },\n    ...\n  ]\n}' },
      { role: 'user', content: `Reviewer's Final Assessment:\n${currentReviewerNotes}\n\nAdversary's Final Critique:\n${currentAdversaryNotes}\n\nPlease provide the final verdict and structured assessment.` }
    ], 'final_decision');
    try {
      const jsonStart = finalDecisionText.indexOf('{');
      const jsonEnd = finalDecisionText.lastIndexOf('}') + 1;
      const jsonStr = finalDecisionText.substring(jsonStart, jsonEnd);
      const parsed = JSON.parse(jsonStr);
      
      assessment.overallVerdict = parsed.overallVerdict;
      assessment.pathway = parsed.pathway;
      assessment.summary = parsed.summary;
      assessment.mandatoryCriteria.met = parsed.mandatoryCriteria.met;
      assessment.mandatoryCriteria.justification = parsed.mandatoryCriteria.justification;
      assessment.optionalCriteria = parsed.optionalCriteria.map((oc: { name: string; met: boolean; justification: string }, index: number) => ({
        id: `OC${index + 1}`,
        name: oc.name,
        description: '',
        met: oc.met,
        justification: oc.justification,
        evidenceReference: []
      }));
    } catch (e) {
      Logger.error('Failed to parse structured final decision', e);
      assessment.overallVerdict = finalDecisionText.includes('ENDORSED') && !finalDecisionText.includes('NOT ENDORSED') ? 'ENDORSED' : 'NOT ENDORSED';
      assessment.summary = finalDecisionText;
    }

    return assessment;
  }
}
