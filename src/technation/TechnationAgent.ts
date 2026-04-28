
import { getLLMProvider } from '../llm/ProviderFactory.js';
import type { LLMProvider, LLMAttachment } from '../types/index.js';
import { REVIEWER_SYSTEM_PROMPT, ADVERSARY_SYSTEM_PROMPT, JUDGE_SYSTEM_PROMPT, MODULAR_MODE_INSTRUCTIONS } from './prompts.js';
import type { TechNationAssessment } from './types.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { CostService } from '../utils/CostService.js';
import type { LLMUsage } from '../types/index.js';


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

  private async chat(provider: any, messages: any[], tag: string, options: any = {}): Promise<string> {
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

    return content;
  }
  private async sortEvidence(applicationText: string, log: (msg: string) => void, attachments?: LLMAttachment[]): Promise<Record<string, { text: string, attachments: LLMAttachment[] }>> {
    // Extract all document names first
    const docNames: string[] = [];
    const chunks = applicationText.split('\n--- DOCUMENT: ');
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const name = chunk.substring(0, chunk.indexOf(' ---')).trim();
      if (name) docNames.push(name);
    }

    const sortingPrompt = `
Analyze the following document names and group them into these categories for UK Global Talent Tech Nation assessment:
1. ELIGIBILITY: CV, Personal Statement, Career history.
2. LETTERS: The 3 Recommendation Letters.
3. MANDATORY: Evidence for Mandatory Criterion (MC).
4. OC1, OC2, OC3, OC4: Evidence for the Optional Criteria.

DOCUMENT LIST:
${docNames.join('\n')}

Output JSON only:
{
  "ELIGIBILITY": ["name1.pdf", ...],
  "LETTERS": ["name2.pdf", ...],
  "MANDATORY": [...],
  "OC1": [...],
  "OC2": [...],
  "OC3": [...],
  "OC4": [...]
}
    `;

    const response = await this.chat(this.reviewer, [
      { role: 'system', content: sortingPrompt },
      { role: 'user', content: 'Map the provided document list into the JSON structure.' }
    ], 'sorting');

    const result: Record<string, { text: string, attachments: LLMAttachment[] }> = {
      'ELIGIBILITY': { text: '', attachments: [] },
      'LETTERS': { text: '', attachments: [] },
      'MANDATORY': { text: '', attachments: [] },
      'OC1': { text: '', attachments: [] },
      'OC2': { text: '', attachments: [] },
      'OC3': { text: '', attachments: [] },
      'OC4': { text: '', attachments: [] }
    };

    try {
      const mapping = JSON.parse(response.substring(response.indexOf('{'), response.lastIndexOf('}') + 1));
      log(`[SORTING COMPLETED] Evidence Map: ${JSON.stringify(mapping, null, 2)}`);
      const documents = applicationText.split('\n--- DOCUMENT: ');
      
      for (const docChunk of documents) {
        if (!docChunk.trim()) continue;
        const firstNewline = docChunk.indexOf(' ---');
        const docName = docChunk.substring(0, firstNewline).trim();
        const docContent = docChunk.substring(docChunk.indexOf('\n') + 1);

        for (const [category, names] of Object.entries(mapping)) {
          const upperCategory = category.toUpperCase();
          if (result[upperCategory] && Array.isArray(names)) {
            if (names.some((n: any) => n && (n.includes(docName) || docName.includes(n)))) {
              result[upperCategory].text += `\n--- DOCUMENT: ${docName} ---\n${docContent}\n`;
              const att = attachments?.find(a => a.name?.includes(docName) || docName.includes(a.name || ''));
              if (att) result[upperCategory].attachments.push(att);
            }
          }
        }
      }
    } catch (e: any) {
      log(`Evidence sorting failed: ${e.message}. Falling back to all-in-one.`);
      result['ELIGIBILITY'] = { text: applicationText, attachments: attachments || [] };
    }

    return result;
  }

  private async assessModule(
    moduleName: string, 
    context: string, 
    moduleContent: { text: string, attachments: LLMAttachment[] }, 
    guides: string,
    log: (msg: string) => void
  ): Promise<string> {
    log(`--- Assessing ${moduleName} ---`);
    let notes = await this.chat(this.reviewer, [
      { role: 'system', content: REVIEWER_SYSTEM_PROMPT + '\n\n' + MODULAR_MODE_INSTRUCTIONS + '\n\n' + guides },
      { role: 'user', content: `Context:\n${context}\n\nEvidence for ${moduleName}:\n${moduleContent.text}`, attachments: moduleContent.attachments }
    ], `${moduleName}_initial`);
    log(`[${moduleName} ASSESSOR INITIAL NOTES]:\n${notes}\n`);

    // Debate loop for module
    let adversaryNotes = await this.chat(this.adversary, [
      { role: 'system', content: ADVERSARY_SYSTEM_PROMPT + '\n\n' + MODULAR_MODE_INSTRUCTIONS + '\n\n' + guides },
      { role: 'user', content: `Module: ${moduleName}\nAssessor's Notes:\n${notes}\n\nEvidence:\n${moduleContent.text}`, attachments: moduleContent.attachments }
    ], `${moduleName}_critique`);
    log(`[${moduleName} REVIEWER AUDIT]:\n${adversaryNotes}\n`);

    notes = await this.chat(this.reviewer, [
      { role: 'system', content: REVIEWER_SYSTEM_PROMPT + '\n\n' + guides },
      { role: 'user', content: `Reviewer's Critique:\n${adversaryNotes}\n\nEvidence:\n${moduleContent.text}\n\nFinalize your notes for ${moduleName}.`, attachments: moduleContent.attachments }
    ], `${moduleName}_final`);

    const interimVerdict = await this.chat(this.judge, [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT + '\n\n' + MODULAR_MODE_INSTRUCTIONS + '\n\n' + guides },
      { role: 'user', content: `Module: ${moduleName}\nAssessor's Notes:\n${notes}\n\nReviewer's Critique:\n${adversaryNotes}\n\nProvide an interim verdict for this specific module.` }
    ], `${moduleName}_verdict`);

    log(`[${moduleName} FINAL VERDICT]: ${interimVerdict}`);

    return `### VERDICT: ${interimVerdict}\n\n### DETAILED NOTES:\n${notes}`;
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
### DOCUMENT 1: OFFICIAL APPLICATION GUIDE
${this.applicationGuide}

### DOCUMENT 2: INTERNAL ASSESSOR GUIDE
${this.assessorGuide}
    `;

    log(`Starting Modular Tech Nation assessment for ${candidateName}`);
    this.totalUsage = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
    this.totalCostUSD = 0;

    const segments = await this.sortEvidence(applicationText, log, attachments);
    
    const manifest = `FULL DOCUMENT MANIFEST (Received and Sorted):\n${Object.entries(segments).filter(([_, s]) => s.text.trim()).map(([cat, s]) => `- ${cat}: ${s.text.split('--- DOCUMENT: ').length - 1} documents`).join('\n')}`;

    // Phase 1: Eligibility
    const eligibilityNotes = await this.assessModule('ELIGIBILITY', `Candidate: ${candidateName}\nTarget Pathway: ${specifiedPathway || 'Unknown'}\n\n${manifest}`, segments['ELIGIBILITY'], combinedGuides, log);
    
    // Phase 2: LETTERS
    const lettersNotes = segments['LETTERS'].text.trim() ? await this.assessModule('LETTERS', eligibilityNotes + '\n' + manifest, segments['LETTERS'], combinedGuides, log) : 'No recommendation letters provided.';

    // Phase 3: MC
    const mcNotes = segments['MANDATORY'].text.trim() ? await this.assessModule('MANDATORY', eligibilityNotes + '\n' + lettersNotes + '\n' + manifest, segments['MANDATORY'], combinedGuides, log) : 'No evidence provided for Mandatory Criterion.';
    
    // Phase 4: OC1
    const oc1Notes = segments['OC1'].text.trim() ? await this.assessModule('OC1', eligibilityNotes + '\n' + lettersNotes + '\n' + mcNotes + '\n' + manifest, segments['OC1'], combinedGuides, log) : '';
    
    // Phase 5: OC2
    const oc2Notes = segments['OC2'].text.trim() ? await this.assessModule('OC2', eligibilityNotes + '\n' + lettersNotes + '\n' + mcNotes + '\n' + oc1Notes + '\n' + manifest, segments['OC2'], combinedGuides, log) : '';

    // Phase 6: OC3
    const oc3Notes = segments['OC3'].text.trim() ? await this.assessModule('OC3', eligibilityNotes + '\n' + lettersNotes + '\n' + mcNotes + '\n' + oc1Notes + '\n' + oc2Notes + '\n' + manifest, segments['OC3'], combinedGuides, log) : '';

    // Phase 7: OC4
    const oc4Notes = segments['OC4'].text.trim() ? await this.assessModule('OC4', eligibilityNotes + '\n' + lettersNotes + '\n' + mcNotes + '\n' + oc1Notes + '\n' + oc2Notes + '\n' + oc3Notes + '\n' + manifest, segments['OC4'], combinedGuides, log) : '';

    // Final Synthesis
    log('Finalizing Holistic Decision...');
    const finalDecisionText = await this.chat(this.judge, [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT + '\n\n' + combinedGuides },
      { role: 'user', content: `
Modular Assessment Notes:
--- ELIGIBILITY ---
${eligibilityNotes}

--- RECOMMENDATION LETTERS ---
${lettersNotes}

--- MANDATORY CRITERION ---
${mcNotes}

--- OPTIONAL CRITERION 1 ---
${oc1Notes}

--- OPTIONAL CRITERION 2 ---
${oc2Notes}

--- OPTIONAL CRITERION 3 ---
${oc3Notes}

--- OPTIONAL CRITERION 4 ---
${oc4Notes}

Reach a final verdict based on the synthesis of these modules.
      ` }
    ], 'final_decision_modular', {
      responseFormat: {
        type: 'json_object',
        schema: {
          type: 'object',
          properties: {
            overallVerdict: { type: 'string', enum: ['ENDORSED', 'NOT ENDORSED', 'INCONCLUSIVE'] },
            pathway: { type: 'string', enum: ['Exceptional Talent', 'Exceptional Promise'] },
            summary: { type: 'string' },
            mandatoryCriteria: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                met: { type: 'boolean' },
                justification: { type: 'string' }
              },
              required: ['id', 'name', 'met', 'justification']
            },
            optionalCriteria: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  met: { type: 'boolean' },
                  justification: { type: 'string' }
                },
                required: ['id', 'name', 'met', 'justification']
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

    const assessment: TechNationAssessment = {
      candidateName: candidateName,
      pathway: specifiedPathway || 'Exceptional Talent',
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

    try {
      const jsonStart = finalDecisionText.indexOf('{');
      const jsonEnd = finalDecisionText.lastIndexOf('}') + 1;
      if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON object found in response');
      
      const jsonStr = finalDecisionText.substring(jsonStart, jsonEnd);
      const parsed = JSON.parse(jsonStr);

      assessment.overallVerdict = parsed.overallVerdict;
      assessment.pathway = parsed.pathway;
      assessment.summary = parsed.summary;
      assessment.mandatoryCriteria = {
        ...assessment.mandatoryCriteria,
        ...parsed.mandatoryCriteria,
        evidenceReference: []
      };
      assessment.optionalCriteria = (parsed.optionalCriteria || []).map((oc: any) => ({
        id: oc.id || 'OC',
        name: oc.name || '',
        description: oc.description || '',
        met: !!oc.met,
        justification: oc.justification || '',
        evidenceReference: []
      }));
      assessment.furtherDetails = parsed.furtherDetails || assessment.furtherDetails;
    } catch (e: any) {
      log(`Error parsing final verdict: ${e.message}. Using fallback.`);
      assessment.overallVerdict = finalDecisionText.includes('ENDORSED') && !finalDecisionText.includes('NOT ENDORSED') ? 'ENDORSED' : 'NOT ENDORSED';
      assessment.summary = finalDecisionText;
    }

    assessment.usage = this.totalUsage;
    assessment.totalCostUSD = this.totalCostUSD;
    
    return assessment;
  }
}
