
import { getLLMProvider } from '../llm/ProviderFactory.js';
import type { LLMProvider } from '../types/index.js';
import { REVIEWER_SYSTEM_PROMPT, ADVERSARY_SYSTEM_PROMPT, JUDGE_SYSTEM_PROMPT } from './prompts.js';
import type { TechNationAssessment } from './types.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CostService } from '../utils/CostService.js';
import type { LLMUsage } from '../types/index.js';

const CACHE_DIR = 'scratch/agent_cache';
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

export class TechnationAgent {
  private reviewer: LLMProvider;
  private adversary: LLMProvider;
  private judge: LLMProvider;
  private applicationGuide: string = '';
  private assessorGuide: string = '';
  private totalUsage: LLMUsage = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
  private totalCostUSD: number = 0;

  constructor() {
    this.reviewer = getLLMProvider();
    this.adversary = getLLMProvider();
    this.judge = getLLMProvider();
  }

  async initialize() {
    const guidesPath = path.resolve(process.cwd(), 'scratch/technation_text');
    const sourceDir = path.resolve(process.cwd(), 'storage');
    
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

    this.applicationGuide = extract('technation_application_guide_updated_2025.pdf');
    this.assessorGuide = extract('technation_asssessor_internal_guide.pdf');
  }

  private async cachedChat(provider: any, messages: any[], tag: string, options: any = {}): Promise<string> {
    const hash = crypto.createHash('md5').update(JSON.stringify({ messages, options })).digest('hex');
    const cachePath = path.join(CACHE_DIR, `${tag}_${hash}.txt`);

    if (fs.existsSync(cachePath)) {
      Logger.info(`[CACHE HIT] Loading ${tag} response from cache...`);
      return fs.readFileSync(cachePath, 'utf-8');
    }

    const response = await (provider as LLMProvider).chat(messages, [], options);
    const content = response.content || '';

    if (response.usage) {
      this.totalUsage.inputTokens += response.usage.inputTokens || 0;
      this.totalUsage.outputTokens += response.usage.outputTokens || 0;
      this.totalUsage.cacheHitTokens = (this.totalUsage.cacheHitTokens || 0) + (response.usage.cacheHitTokens || 0);
      this.totalUsage.cacheMissTokens = (this.totalUsage.cacheMissTokens || 0) + (response.usage.cacheMissTokens || 0);
      
      const model = (provider as any).model || 'unknown';
      const cost = CostService.calculateCost(model, response.usage);
      this.totalCostUSD += cost;
      Logger.info(`[COST] ${tag} (${model}): $${cost.toFixed(6)} (Usage: ${response.usage.inputTokens} in, ${response.usage.outputTokens} out)`);
    }

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
    this.totalUsage = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
    this.totalCostUSD = 0;

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
      furtherDetails: {
        outstandingTrackRecord: false,
        strengthOfEvidence: false,
        meritOfPresenceInUK: false,
        sufficientLeadershipEvidence: false,
        evidenceWithinFiveYears: false
      },
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
    log('Analyzing evidence...it might take some minutes to see further updates...');
    currentReviewerNotes = await this.cachedChat(this.reviewer, [
      { role: 'system', content: REVIEWER_SYSTEM_PROMPT + '\n\n' + combinedGuides },
      { role: 'user', content: `Candidate: ${finalCandidateName}\nPathway: ${finalPathway}\n\nApplication Documents:\n${applicationText}`, attachments }
    ], 'reviewer_initial_v2');
    log(`--- INITIAL REVIEW FULL TRANSCRIPT---\n`)
    log(`${currentReviewerNotes}\n`);

    while (!consensusReached && roundCount < maxRounds) {
      roundCount++;
      log(`Round ${roundCount}: Assessment in Progress`);

      // Reviewer Turn
      log(`Round ${roundCount}: Assessor's Critique...`);
      currentAdversaryNotes = await this.cachedChat(this.adversary, [
        { role: 'system', content: ADVERSARY_SYSTEM_PROMPT + '\n\n' + combinedGuides },
        { role: 'user', content: `Assessor's Assessment:\n${currentReviewerNotes}\n\nCandidate Application:\n${applicationText}\n\nPlease critique the initial assessment using the guides.`, attachments }
      ], `adversary_r${roundCount}_v2`);
      log(`--- REVIEWER CRITIQUE (Round ${roundCount}) ---\n`)
      log(`${currentAdversaryNotes}\n`);

      // Assessor Response
      log(`Round ${roundCount}: Reviewer's Rebuttal...`);
      currentReviewerNotes = await this.cachedChat(this.reviewer, [
        { role: 'system', content: REVIEWER_SYSTEM_PROMPT + '\n\n' + combinedGuides },
        { role: 'user', content: `Reviewer's Critique:\n${currentAdversaryNotes}\n\nCandidate Application:\n${applicationText}\n\nRespond to the critique and provide your updated assessment.`, attachments }
      ], `reviewer_r${roundCount}_v2`);
      log(`--- ASSESSOR UPDATED NOTES (Round ${roundCount}) ---`)
      log( `${currentReviewerNotes}\n`);

      // Judge Turn
      log(`Round ${roundCount}: Endorser Evaluation...`);
      const judgeVerdictJson = await this.cachedChat(this.judge, [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT + '\n\n' + combinedGuides },
        { role: 'user', content: `Assessor's Notes:\n${currentReviewerNotes}\n\nReviewer's Critique:\n${currentAdversaryNotes}\n\nReach a decision according to the guides.` }
      ], `judge_r${roundCount}_v2`, {
        responseFormat: {
          type: 'json_object',
          schema: {
            type: 'object',
            properties: {
              verdict: { type: 'string', enum: ['ENDORSED', 'NOT ENDORSED'], description: 'The final decision on the application.' },
              justification: { type: 'string', description: 'Brief explanation for the verdict.' },
              consensusReached: { type: 'boolean', description: 'Whether the debate between Assessor and Reviewer is fully resolved.' }
            },
            required: ['verdict', 'justification', 'consensusReached']
          }
        }
      });

      let parsedVerdict;
      try {
          parsedVerdict = JSON.parse(judgeVerdictJson);
          consensusReached = parsedVerdict.consensusReached || roundCount >= maxRounds;
      } catch (e) {
          log('Error parsing judge verdict JSON, falling back to string check.');
          consensusReached = judgeVerdictJson.includes('CONSENSUS REACHED') || roundCount >= maxRounds;
      }

      const verdictObj = parsedVerdict || { verdict: 'NOT ENDORSED', justification: judgeVerdictJson };
      log(`--- ENDORSER VERDICT (Round ${roundCount}) ---`);
      log(`**Verdict:** ${verdictObj.verdict}`);
      log(`**Justification:** ${verdictObj.justification}`);
      log(`**Consensus Reached:** ${consensusReached ? 'YES' : 'NO'}`);

      assessment.rounds.push({
        roundNumber: roundCount,
        reviewerNotes: currentReviewerNotes,
        adversaryNotes: currentAdversaryNotes,
        consensusReached,
        currentVerdict: parsedVerdict?.verdict || (judgeVerdictJson.includes('ENDORSED') && !judgeVerdictJson.includes('NOT ENDORSED') ? 'ENDORSED' : 'NOT ENDORSED')
      });
    }

    // Final verdict
    log('Finalizing Decision...');
    const finalDecisionText = await this.cachedChat(this.judge, [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT + '\n\n' + combinedGuides },
      { role: 'user', content: `Assessor's Final Notes:\n${currentReviewerNotes}\n\nReviewer's Final Critique:\n${currentAdversaryNotes}` }
    ], 'final_decision_v4', {
      responseFormat: {
        type: 'json_object',
        schema: {
          type: 'object',
          properties: {
            overallVerdict: { type: 'string', enum: ['ENDORSED', 'NOT ENDORSED'] },
            pathway: { type: 'string', enum: ['Exceptional Talent', 'Exceptional Promise'] },
            summary: { type: 'string' },
            mandatoryCriteria: {
              type: 'object',
              properties: {
                met: { type: 'boolean' },
                justification: { type: 'string' }
              },
              required: ['met', 'justification']
            },
            optionalCriteria: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  met: { type: 'boolean' },
                  justification: { type: 'string' }
                },
                required: ['name', 'met', 'justification']
              }
            },
            furtherDetails: {
              type: 'object',
              properties: {
                outstandingTrackRecord: { type: 'boolean' },
                strengthOfEvidence: { type: 'boolean' },
                meritOfPresenceInUK: { type: 'boolean' },
                sufficientLeadershipEvidence: { type: 'boolean' },
                evidenceWithinFiveYears: { type: 'boolean' }
              },
              required: ['outstandingTrackRecord', 'strengthOfEvidence', 'meritOfPresenceInUK', 'sufficientLeadershipEvidence', 'evidenceWithinFiveYears']
            }
          },
          required: ['overallVerdict', 'pathway', 'summary', 'mandatoryCriteria', 'optionalCriteria', 'furtherDetails']
        }
      }
    });

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
      assessment.furtherDetails = parsed.furtherDetails;
    } catch (e) {
      assessment.overallVerdict = finalDecisionText.includes('ENDORSED') && !finalDecisionText.includes('NOT ENDORSED') ? 'ENDORSED' : 'NOT ENDORSED';
      assessment.summary = finalDecisionText;
    }

    assessment.usage = this.totalUsage;
    assessment.totalCostUSD = this.totalCostUSD;
    
    Logger.info(`Assessment complete. Total Usage: ${this.totalUsage.inputTokens} input, ${this.totalUsage.outputTokens} output tokens.`);
    Logger.info(`Total Estimated Cost: $${assessment.totalCostUSD.toFixed(4)}`);

    return assessment;
  }
}
