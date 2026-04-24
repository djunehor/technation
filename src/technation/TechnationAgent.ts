
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
    const guidesPath = './scratch/technation_text';
    const sourceDir = './TECHNATION';
    const files = [
      'Tech Nation - Global Talent Visa Application Guide.pdf',
      'Tech Nation Internal Assessor Guide.pdf'
    ];

    if (!fs.existsSync(guidesPath)) {
      fs.mkdirSync(guidesPath, { recursive: true });
    }

    const { spawnSync } = await import('child_process');

    this.guidesContent = files.map(f => {
      const textFile = f.replace('.pdf', '.txt');
      const textPath = path.join(guidesPath, textFile);
      const sourcePath = path.join(sourceDir, f);

      if (!fs.existsSync(textPath)) {
        Logger.info(`Extracting guides from ${f}...`);
        const result = spawnSync('pdftotext', [sourcePath, '-'], { encoding: 'utf-8' });
        if (result.stdout) {
          fs.writeFileSync(textPath, result.stdout);
        }
      }

      const content = fs.readFileSync(textPath, 'utf-8');
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

  async assess(
    candidateName: string,
    applicationText: string,
    options?: {
      pathway?: 'Exceptional Talent' | 'Exceptional Promise',
      targetCriteria?: string,
      onUpdate?: (message: string) => void
    }
  ): Promise<TechNationAssessment> {
    const { pathway: specifiedPathway, onUpdate } = options || {};
    const log = (msg: string) => {
      Logger.info(msg);
      if (onUpdate) onUpdate(msg);
    };

    log(`Starting Tech Nation assessment for ${candidateName}`);

    // Pre-analysis: Extract Candidate Name and Pathway if not clearly provided
    let finalCandidateName = candidateName;
    let finalPathway = specifiedPathway;

    if (candidateName === 'Applicant' || candidateName === 'Unknown Candidate' || !specifiedPathway) {
      log('Identifying candidate and pathway from documents...');
      const preAnalysisText = await this.cachedChat(this.reviewer, [
        { role: 'system', content: 'Extract the candidate name and determine if they are applying for "Exceptional Talent" or "Exceptional Promise". Output JSON: { "name": "...", "pathway": "..." }' },
        { role: 'user', content: applicationText.substring(0, 10000) }
      ], 'pre_analysis');

      try {
        const parsed = JSON.parse(preAnalysisText.substring(preAnalysisText.indexOf('{'), preAnalysisText.lastIndexOf('}') + 1));
        if (candidateName === 'Applicant' || candidateName === 'Unknown Candidate') finalCandidateName = parsed.name || candidateName;
        if (!specifiedPathway) finalPathway = parsed.pathway || 'Exceptional Talent';
        log(`Detected: ${finalCandidateName} (${finalPathway})`);
      } catch (e) {
        log('Using default context.');
      }
    }

    const assessment: TechNationAssessment = {
      candidateName: finalCandidateName,
      pathway: finalPathway || 'Exceptional Talent',
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
    log('Analyzing evidence...');
    currentReviewerNotes = await this.cachedChat(this.reviewer, [
      { role: 'system', content: REVIEWER_SYSTEM_PROMPT + '\n\n' + this.guidesContent },
      { role: 'user', content: `Candidate: ${finalCandidateName}\nPathway: ${finalPathway}\n\nApplication Documents:\n${applicationText}` }
    ], 'reviewer_initial');
    log(`--- INITIAL REVIEW FULL TRANSCRIPT ---\n${currentReviewerNotes}\n`);

    while (!consensusReached && roundCount < maxRounds) {
      roundCount++;
      log(`Round ${roundCount}: Adversarial Debate`);

      // Adversary's Turn
      log(`Round ${roundCount}: Adversary's Turn - Checking cache or calling LLM...`);
      currentAdversaryNotes = await this.cachedChat(this.adversary, [
        { role: 'system', content: ADVERSARY_SYSTEM_PROMPT + '\n\n' + this.guidesContent },
        { role: 'user', content: `Reviewer's Assessment:\n${currentReviewerNotes}\n\nCandidate Application:\n${applicationText}\n\nPlease critique the Reviewer's assessment. Be as critical as possible based on the guides.` }
      ], `adversary_r${roundCount}`);
      log(`--- ADVERSARY CRITIQUE (Round ${roundCount}) ---\n${currentAdversaryNotes}\n`);

      // Reviewer's Rebuttal/Update
      log(`Round ${roundCount}: Reviewer's Rebuttal - Checking cache or calling LLM...`);
      currentReviewerNotes = await this.cachedChat(this.reviewer, [
        { role: 'system', content: REVIEWER_SYSTEM_PROMPT + '\n\n' + this.guidesContent },
        { role: 'user', content: `Adversary's Critique:\n${currentAdversaryNotes}\n\nCandidate Application:\n${applicationText}\n\nRespond to the critique and provide your updated (and potentially final) assessment.` }
      ], `reviewer_r${roundCount}`);
      log(`--- REVIEWER UPDATED ASSESSMENT (Round ${roundCount}) ---\n${currentReviewerNotes}\n`);

      // Judge's Evaluation
      log(`Round ${roundCount}: Judge's Evaluation - Checking cache or calling LLM...`);
      const judgeVerdictText = await this.cachedChat(this.judge, [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT + '\n\n' + this.guidesContent },
        { role: 'user', content: `Reviewer's Assessment:\n${currentReviewerNotes}\n\nAdversary's Critique:\n${currentAdversaryNotes}\n\nHas consensus been reached? If so, what is the final verdict (ENDORSED or NOT ENDORSED)? If not, summarize the remaining points of contention.` }
      ], `judge_r${roundCount}`);

      log(`--- JUDGE ROUND EVALUATION (Round ${roundCount}) ---\n${judgeVerdictText}\n`);
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
    log('Final Decision - Checking cache or calling LLM...');
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
