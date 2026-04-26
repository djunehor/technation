
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
  private applicationGuide: string = '';
  private assessorGuide: string = '';

  constructor() {
    this.reviewer = getLLMProvider();
    this.adversary = getLLMProvider();
    this.judge = getLLMProvider();
  }

  async initialize() {
    const guidesPath = './scratch/technation_text';
    const sourceDir = './guides';
    
    if (!fs.existsSync(guidesPath)) {
      fs.mkdirSync(guidesPath, { recursive: true });
    }

    const { spawnSync } = await import('child_process');

    const extract = (pdfName: string) => {
      const textFile = pdfName.replace('.pdf', '.txt');
      const textPath = path.join(guidesPath, textFile);
      const sourcePath = path.join(sourceDir, pdfName);

      if (!fs.existsSync(textPath)) {
        if (!fs.existsSync(sourcePath)) {
          Logger.error(`Source guide PDF not found: ${sourcePath}`);
          return `[ERROR: Source guide not found: ${pdfName}]`;
        }
        Logger.info(`Extracting guides from ${pdfName}...`);
        try {
          const result = spawnSync('pdftotext', [sourcePath, '-'], { encoding: 'utf-8' });
          if (result.stdout) {
            fs.writeFileSync(textPath, result.stdout);
          }
        } catch (e) {}
      }

      return fs.existsSync(textPath) ? fs.readFileSync(textPath, 'utf-8') : `[ERROR: Missing text for ${pdfName}]`;
    };

    this.applicationGuide = extract('global_talent_visa_guide.pdf');
    this.assessorGuide = extract('internal_assessor_guide.pdf');
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
      onUpdate?: (message: string) => void,
      attachments?: import('../types/index.js').LLMAttachment[]
    }
  ): Promise<TechNationAssessment> {
    const { pathway: specifiedPathway, onUpdate, attachments } = options || {};
    const log = (msg: string) => {
      Logger.info(msg);
      if (onUpdate) onUpdate(msg);
    };

    const combinedGuides = `
### DOCUMENT 1: OFFICIAL APPLICATION GUIDE (Rules for Applicants)
${this.applicationGuide}

### DOCUMENT 2: INTERNAL ASSESSOR GUIDE (Rules for Scoring and Decision Making)
${this.assessorGuide}
    `;

    log(`Starting Tech Nation assessment for ${candidateName}`);

    // Pre-analysis: Extract Candidate Name and Pathway if not clearly provided
    let finalCandidateName = candidateName;
    let finalPathway = specifiedPathway;

    if (candidateName === 'Applicant' || candidateName === 'Unknown Candidate' || !specifiedPathway) {
      log('Identifying candidate and pathway from documents...');
      const preAnalysisText = await this.cachedChat(this.reviewer, [
        { role: 'system', content: 'Extract the candidate name and determine if they are applying for "Exceptional Talent" or "Exceptional Promise". Output JSON: { "name": "...", "pathway": "..." }' },
        { role: 'user', content: applicationText.substring(0, 10000), attachments: attachments?.slice(0, 3) } // Only first few for pre-analysis
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
      { role: 'system', content: REVIEWER_SYSTEM_PROMPT + '\n\n' + combinedGuides },
      { role: 'user', content: `Candidate: ${finalCandidateName}\nPathway: ${finalPathway}\n\nApplication Documents:\n${applicationText}`, attachments }
    ], 'reviewer_initial');
    log(`--- INITIAL REVIEW FULL TRANSCRIPT ---\n${currentReviewerNotes}\n`);

    while (!consensusReached && roundCount < maxRounds) {
      roundCount++;
      log(`Round ${roundCount}: Peer Review`);

      // Reviewer Turn
      log(`Round ${roundCount}: Reviewer Critique - Checking cache...`);
      currentAdversaryNotes = await this.cachedChat(this.adversary, [
        { role: 'system', content: ADVERSARY_SYSTEM_PROMPT + '\n\n' + combinedGuides },
        { role: 'user', content: `Assessor's Assessment:\n${currentReviewerNotes}\n\nCandidate Application:\n${applicationText}\n\nPlease critique the initial assessment using the guides.`, attachments }
      ], `adversary_r${roundCount}`);
      log(`--- PEER REVIEW CRITIQUE (Round ${roundCount}) ---\n${currentAdversaryNotes}\n`);

      // Assessor Response
      log(`Round ${roundCount}: Assessor Rebuttal - Checking cache...`);
      currentReviewerNotes = await this.cachedChat(this.reviewer, [
        { role: 'system', content: REVIEWER_SYSTEM_PROMPT + '\n\n' + combinedGuides },
        { role: 'user', content: `Reviewer's Critique:\n${currentAdversaryNotes}\n\nCandidate Application:\n${applicationText}\n\nRespond to the critique and provide your updated assessment.`, attachments }
      ], `reviewer_r${roundCount}`);
      log(`--- ASSESSOR UPDATED NOTES (Round ${roundCount}) ---\n${currentReviewerNotes}\n`);

      // Judge Turn
      log(`Round ${roundCount}: Chief Endorser Evaluation - Checking cache...`);
      const judgeVerdictText = await this.cachedChat(this.judge, [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT + '\n\n' + combinedGuides },
        { role: 'user', content: `Assessor's Notes:\n${currentReviewerNotes}\n\nReviewer's Critique:\n${currentAdversaryNotes}\n\nReach a decision according to the guides.` }
      ], `judge_r${roundCount}`);

      log(`--- CHIEF ENDORSER VERDICT (Round ${roundCount}) ---\n${judgeVerdictText}\n`);
      consensusReached = judgeVerdictText.includes('CONSENSUS REACHED') || roundCount >= maxRounds;

      assessment.rounds.push({
        roundNumber: roundCount,
        reviewerNotes: currentReviewerNotes,
        adversaryNotes: currentAdversaryNotes,
        consensusReached,
        currentVerdict: judgeVerdictText.includes('ENDORSED') && !judgeVerdictText.includes('NOT ENDORSED') ? 'ENDORSED' : 'NOT ENDORSED'
      });
    }

    // Final verdict
    log('Finalizing Decision...');
    const finalDecisionText = await this.cachedChat(this.judge, [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT + '\n\n' + combinedGuides + '\n\nOutput JSON:\n{\n  "overallVerdict": "ENDORSED" | "NOT ENDORSED",\n  "pathway": "Exceptional Talent" | "Exceptional Promise",\n  "summary": "...",\n  "mandatoryCriteria": { "met": boolean, "justification": "..." },\n  "optionalCriteria": [\n    { "name": "OC1", "met": boolean, "justification": "..." },\n    ...\n  ]\n}' },
      { role: 'user', content: `Assessor's Final Notes:\n${currentReviewerNotes}\n\nReviewer's Final Critique:\n${currentAdversaryNotes}` }
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
      assessment.optionalCriteria = parsed.optionalCriteria.map((oc: any, index: number) => ({
        id: `OC${index + 1}`,
        name: oc.name,
        description: '',
        met: oc.met,
        justification: oc.justification,
        evidenceReference: []
      }));
    } catch (e) {
      assessment.overallVerdict = finalDecisionText.includes('ENDORSED') && !finalDecisionText.includes('NOT ENDORSED') ? 'ENDORSED' : 'NOT ENDORSED';
      assessment.summary = finalDecisionText;
    }

    return assessment;
  }
}
