
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

Also, determine if the applicant is applying for "Exceptional Talent" or "Exceptional Promise" based on the document names.

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
  "OC4": [...],
  "pathway": "Exceptional Talent" | "Exceptional Promise"
}
    `;

    const response = await this.chat(this.reviewer, [
      { role: 'system', content: sortingPrompt },
      { role: 'user', content: 'Map the provided document list into the JSON structure and determine the pathway.' }
    ], 'sorting');

    const result: Record<string, { text: string, attachments: LLMAttachment[], pathway?: string }> = {
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
      log(`[SORTING COMPLETED] Successfully mapped documents.`);
      
      if (mapping.pathway) {
        result.pathway = mapping.pathway;
      }

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
              const att = attachments?.find(a => a.name?.includes(docName) || docName.includes(a.name || ''));
              
              if (att) {
                result[upperCategory].attachments.push(att);
                // If provider supports attachments, don't bloat context with extracted text
                if (this.reviewer.supportsAttachments) {
                  result[upperCategory].text += `\n--- DOCUMENT: ${docName} --- (Visual content sent as attachment)\n`;
                } else {
                  result[upperCategory].text += `\n--- DOCUMENT: ${docName} ---\n${docContent}\n`;
                }
              } else {
                result[upperCategory].text += `\n--- DOCUMENT: ${docName} ---\n${docContent}\n`;
              }
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
  ): Promise<{ decision: 'ENDORSED' | 'NOT ENDORSED', justification: string, notes: string }> {
    log(`--- Assessing ${moduleName} ---`);
    let notes = await this.chat(this.reviewer, [
      { role: 'system', content: REVIEWER_SYSTEM_PROMPT + '\n\n' + MODULAR_MODE_INSTRUCTIONS + '\n\n' + guides },
      { role: 'user', content: `Context:\n${context}\n\nEvidence for ${moduleName}:\n${moduleContent.text}`, attachments: moduleContent.attachments }
    ], `${moduleName}_initial`);
    log(`[${moduleName} ASSESSOR INITIAL NOTES]:\n${notes}\n`);

    // Debate loop for module
    let adversaryNotes = await this.chat(this.adversary, [
      { role: 'system', content: ADVERSARY_SYSTEM_PROMPT + '\n\n' + MODULAR_MODE_INSTRUCTIONS + '\n\n' + guides },
      { role: 'user', content: `Module: ${moduleName}\nContext:\n${context}\n\nAssessor's Notes:\n${notes}\n\nEvidence:\n${moduleContent.text}`, attachments: moduleContent.attachments }
    ], `${moduleName}_critique`);
    log(`[${moduleName} REVIEWER AUDIT]:\n${adversaryNotes}\n`);

    notes = await this.chat(this.reviewer, [
      { role: 'system', content: REVIEWER_SYSTEM_PROMPT + '\n\n' + guides },
      { role: 'user', content: `Reviewer's Critique:\n${adversaryNotes}\n\nEvidence:\n${moduleContent.text}\n\nFinalize your notes for ${moduleName}.`, attachments: moduleContent.attachments }
    ], `${moduleName}_final`);

    const interimVerdictJson = await this.chat(this.judge, [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT + '\n\n' + MODULAR_MODE_INSTRUCTIONS + '\n\n' + guides },
      { role: 'user', content: `Module: ${moduleName}\nAssessor's Notes:\n${notes}\n\nReviewer's Critique:\n${adversaryNotes}\n\nProvide an interim verdict for this specific module.` }
    ], `${moduleName}_verdict`, {
      responseFormat: {
        type: 'json_object',
        schema: {
          type: 'object',
          properties: {
            decision: { type: 'string', enum: ['ENDORSED', 'NOT ENDORSED'] },
            justification: { type: 'string' }
          },
          required: ['decision', 'justification']
        }
      }
    });

    let parsedVerdict: { decision: 'ENDORSED' | 'NOT ENDORSED', justification: string } = { 
      decision: 'NOT ENDORSED', 
      justification: 'Failed to parse interim verdict.' 
    };
    try {
      parsedVerdict = JSON.parse(interimVerdictJson);
    } catch (e) {
      log(`[ERROR] Failed to parse interim verdict for ${moduleName}: ${interimVerdictJson}`);
      if (interimVerdictJson.includes('ENDORSED')) parsedVerdict.decision = 'ENDORSED';
    }

    log(`[${moduleName} FINAL VERDICT]: ${parsedVerdict.decision}\nJustification: ${parsedVerdict.justification}`);

    return { 
      decision: parsedVerdict.decision, 
      justification: parsedVerdict.justification,
      notes: notes
    };
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

    const segments = await this.sortEvidence(applicationText, log, attachments);
    
    if (!specifiedPathway && (segments as any).pathway) {
      assessment.pathway = (segments as any).pathway;
      log(`[PATHWAY DETECTED] LLM detected pathway from documents: ${assessment.pathway}`);
    }

    const manifest = `FULL DOCUMENT MANIFEST (Received and Sorted):\n${Object.entries(segments).filter(([key, s]) => key !== 'pathway' && (s as any).text?.trim()).map(([cat, s]) => `- ${cat}: ${(s as any).text.split('--- DOCUMENT: ').length - 1} documents`).join('\n')}`;

    // Helper to update assessment from module result
    const updateAssessment = (moduleName: string, result: { decision: 'ENDORSED' | 'NOT ENDORSED', justification: string, notes: string }) => {
      const isMet = result.decision === 'ENDORSED';
      
      if (moduleName === 'MANDATORY') {
        assessment.mandatoryCriteria.met = isMet;
        assessment.mandatoryCriteria.justification = result.notes;
      } else if (moduleName.startsWith('OC')) {
        assessment.optionalCriteria.push({
          id: moduleName,
          name: moduleName,
          description: '',
          met: isMet,
          justification: result.notes,
          evidenceReference: []
        });
      } else if (moduleName === 'ELIGIBILITY') {
        // No longer auto-detecting here to avoid brittle overwrites
      }
    };

    // Phase 1: Eligibility
    const eligibilityResult = await this.assessModule('ELIGIBILITY', `Candidate: ${candidateName}\nTarget Pathway: ${specifiedPathway || 'Unknown'}\n\n${manifest}`, segments['ELIGIBILITY'], combinedGuides, log);
    updateAssessment('ELIGIBILITY', eligibilityResult);
    
    // Phase 2: LETTERS
    const lettersResult = segments['LETTERS'].text.trim() 
      ? await this.assessModule('LETTERS', eligibilityResult.notes + '\n' + manifest, segments['LETTERS'], combinedGuides, log) 
      : { decision: 'NOT ENDORSED' as const, justification: 'No recommendation letters provided.', notes: 'No recommendation letters provided.' };
    updateAssessment('LETTERS', lettersResult);

    // Phase 3: MC
    const mcResult = segments['MANDATORY'].text.trim() 
      ? await this.assessModule('MANDATORY', eligibilityResult.notes + '\n' + lettersResult.notes + '\n' + manifest, segments['MANDATORY'], combinedGuides, log) 
      : { decision: 'NOT ENDORSED' as const, justification: 'No evidence provided for Mandatory Criterion.', notes: 'No evidence provided for Mandatory Criterion.' };
    updateAssessment('MANDATORY', mcResult);
    
    // Phase 4: OC1
    const oc1Result = segments['OC1'].text.trim() ? await this.assessModule('OC1', eligibilityResult.notes + '\n' + lettersResult.notes + '\n' + mcResult.notes + '\n' + manifest, segments['OC1'], combinedGuides, log) : null;
    if (oc1Result) updateAssessment('OC1', oc1Result);
    
    // Phase 5: OC2
    const oc2Result = segments['OC2'].text.trim() ? await this.assessModule('OC2', eligibilityResult.notes + '\n' + lettersResult.notes + '\n' + mcResult.notes + '\n' + (oc1Result?.notes || '') + '\n' + manifest, segments['OC2'], combinedGuides, log) : null;
    if (oc2Result) updateAssessment('OC2', oc2Result);

    // Phase 6: OC3
    const oc3Result = segments['OC3'].text.trim() ? await this.assessModule('OC3', eligibilityResult.notes + '\n' + lettersResult.notes + '\n' + mcResult.notes + '\n' + (oc1Result?.notes || '') + '\n' + (oc2Result?.notes || '') + '\n' + manifest, segments['OC3'], combinedGuides, log) : null;
    if (oc3Result) updateAssessment('OC3', oc3Result);

    // Phase 7: OC4
    const oc4Result = segments['OC4'].text.trim() ? await this.assessModule('OC4', eligibilityResult.notes + '\n' + lettersResult.notes + '\n' + mcResult.notes + '\n' + (oc1Result?.notes || '') + '\n' + (oc2Result?.notes || '') + '\n' + (oc3Result?.notes || '') + '\n' + manifest, segments['OC4'], combinedGuides, log) : null;
    if (oc4Result) updateAssessment('OC4', oc4Result);

    // Final Synthesis
    log('Finalizing Holistic Decision...');
    const historyText = `ELIGIBILITY: ${eligibilityResult.notes}\nLETTERS: ${lettersResult.notes}\nMC: ${mcResult.notes}\nOC1: ${oc1Result?.notes || ''}\nOC2: ${oc2Result?.notes || ''}\nOC3: ${oc3Result?.notes || ''}\nOC4: ${oc4Result?.notes || ''}`;
    
    const finalDecisionText = await this.chat(this.judge, [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT + '\n\n' + combinedGuides },
      { role: 'user', content: `Candidate: ${candidateName}\n\nReview the following assessment history and provide a final holistic decision.\n\n${historyText}` }
    ], 'final_decision_modular', {
      responseFormat: {
        type: 'json_object',
        schema: {
          type: 'object',
          properties: {
            overallVerdict: { type: 'string', enum: ['ENDORSED', 'NOT ENDORSED'] },
            summary: { type: 'string' },
            furtherDetails: {
              type: 'object',
              properties: {
                outstandingTrackRecord: { type: 'boolean' },
                strengthOfEvidence: { type: 'boolean' },
                meritOfPresenceInUK: { type: 'boolean' },
                sufficientLeadershipEvidence: { type: 'boolean' },
                evidenceWithinFiveYears: { type: 'boolean' }
              }
            }
          },
          required: ['overallVerdict', 'summary', 'furtherDetails']
        }
      }
    });

    try {
      const jsonStart = finalDecisionText.indexOf('{');
      const jsonEnd = finalDecisionText.lastIndexOf('}') + 1;
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const jsonStr = finalDecisionText.substring(jsonStart, jsonEnd);
        const parsed = JSON.parse(jsonStr);

        assessment.overallVerdict = parsed.overallVerdict || (finalDecisionText.includes('ENDORSED') && !finalDecisionText.includes('NOT ENDORSED') ? 'ENDORSED' : 'NOT ENDORSED');
        assessment.summary = parsed.summary || finalDecisionText;
        assessment.furtherDetails = parsed.furtherDetails || assessment.furtherDetails;
        
        log(`[FINAL DECISION]: ${assessment.overallVerdict}`);
        log(`[FINAL SUMMARY]: ${assessment.summary}`);
      } else {
        throw new Error('No JSON object found');
      }
    } catch (e: any) {
      log(`Error parsing final verdict JSON: ${e.message}. Using robust fallback.`);
      assessment.overallVerdict = finalDecisionText.includes('ENDORSED') && !finalDecisionText.includes('NOT ENDORSED') ? 'ENDORSED' : 'NOT ENDORSED';
      assessment.summary = finalDecisionText || "Holistic assessment complete based on modular results.";
      log(`[FINAL DECISION (FALLBACK)]: ${assessment.overallVerdict}`);
    }

    // Final safety check: if MC or Letters failed, the overall verdict MUST be NOT ENDORSED
    if (!assessment.mandatoryCriteria.met || (lettersResult && lettersResult.decision === 'NOT ENDORSED')) {
      assessment.overallVerdict = 'NOT ENDORSED';
      log(`[OVERRIDE]: Setting overall verdict to NOT ENDORSED because Mandatory Criteria or Letters were not satisfied.`);
    }

    assessment.usage = this.totalUsage;
    assessment.totalCostUSD = this.totalCostUSD;
    
    return assessment;
  }
}
