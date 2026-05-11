
import { getLLMProvider } from '../llm/ProviderFactory.js';
import type { LLMProvider, LLMAttachment } from '../types/index.js';
import { REVIEWER_SYSTEM_PROMPT, ADVERSARY_SYSTEM_PROMPT, JUDGE_SYSTEM_PROMPT, DOCUMENT_LEVEL_INSTRUCTIONS, SECTION_SYNTHESIS_INSTRUCTIONS } from './prompts.js';
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
      const cacheInfo = response.usage.cacheHitTokens
        ? ` cacheHit=${response.usage.cacheHitTokens}`
        : '';
      Logger.info(`[COST] ${tag} (${model}): $${cost.toFixed(6)} | in=${response.usage.inputTokens} out=${response.usage.outputTokens}${cacheInfo} | runTotal=$${this.totalCostUSD.toFixed(4)}`);
    }

    return content;
  }
  private async sortEvidence(applicationText: string, log: (msg: string) => void, attachments?: LLMAttachment[]): Promise<Record<string, { text: string, attachments: LLMAttachment[] }>> {
    const clean = (s: string) => s.replace(/[^a-z0-9.]/gi, '_').replace(/\s+/g, ' ').trim();

    // Extract all document names first
    const docNames: string[] = [];
    const chunks = applicationText.split('\n--- DOCUMENT: ');
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const firstMarker = chunk.indexOf(' ---');
      if (firstMarker === -1) continue;
      const name = chunk.substring(0, firstMarker).trim();
      if (name) docNames.push(clean(name));
    }

    const sortingPrompt = `
Analyze the following document names and group them into these categories for UK Global Talent Tech Nation assessment:
1. ELIGIBILITY: CV, Personal Statement, Career history.
2. LETTERS: The 3 Recommendation Letters.
3. MANDATORY: Evidence for Mandatory Criterion (MC).
4. OC1, OC2, OC3, OC4: Evidence for the Optional Criteria.

Also, determine if the applicant is applying for "Exceptional Talent" or "Exceptional Promise" based on the document names.

!!IMPORTANT!!!: All files must be mapped to one of the categories. If a file is not mapped to any category, it will be lost.

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
        if (firstNewline === -1) continue;
        const docName = docChunk.substring(0, firstNewline).trim();
        const cleanDocName = clean(docName);
        const docContent = docChunk.substring(docChunk.indexOf('\n') + 1);

        for (const [category, names] of Object.entries(mapping)) {
          const upperCategory = category.toUpperCase();
          if (result[upperCategory] && Array.isArray(names)) {
            if (names.some((n: any) => n && (clean(String(n)) === cleanDocName))) {
              const att = attachments?.find(a => a.name && clean(a.name) === cleanDocName);
              
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


  private splitSectionIntoDocuments(
    sectionText: string,
    sectionAttachments: LLMAttachment[]
  ): Array<{ name: string; text: string; attachments: LLMAttachment[] }> {
    const docs: Array<{ name: string; text: string; attachments: LLMAttachment[] }> = [];
    const chunks = sectionText.split('\n--- DOCUMENT: ');
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const endMarker = chunk.indexOf(' ---');
      if (endMarker === -1) continue;
      const docName = chunk.substring(0, endMarker).trim();
      const newline = chunk.indexOf('\n');
      const docContent = newline !== -1 ? chunk.substring(newline + 1) : '';
      const docAttachments = sectionAttachments.filter(a =>
        a.name && (a.name.includes(docName) || docName.includes(a.name))
      );
      if (docName) docs.push({ name: docName, text: docContent, attachments: docAttachments });
    }
    return docs;
  }

  private async assessDocument(
    docName: string,
    sectionName: string,
    docContent: { text: string; attachments: LLMAttachment[] },
    context: string,
    guides: string,
    log: (msg: string) => void
  ): Promise<{ decision: 'SATISFACTORY' | 'UNSATISFACTORY'; notes: string; justification: string }> {
    log(`  → [${sectionName}] Assessing document: ${docName}`);
    const tag = `${sectionName}:${docName}`;
    const userContent = `Context:\n${context}\n\nSection: ${sectionName}\nDocument: ${docName}\n\n${docContent.text}`;

    // Step 1: Assessor
    const assessorNotes = await this.chat(this.reviewer, [
      { role: 'system', content: REVIEWER_SYSTEM_PROMPT + '\n\n' + DOCUMENT_LEVEL_INSTRUCTIONS + '\n\n' + guides },
      { role: 'user', content: userContent, attachments: docContent.attachments }
    ], `${tag}_assessor`);
    log(`[${tag} ASSESSOR]:\n${assessorNotes}\n`);

    // Step 2: Reviewer
    const reviewerNotes = await this.chat(this.adversary, [
      { role: 'system', content: ADVERSARY_SYSTEM_PROMPT + '\n\n' + DOCUMENT_LEVEL_INSTRUCTIONS + '\n\n' + guides },
      { role: 'user', content: `Document: ${docName} (Section: ${sectionName})\nContext:\n${context}\n\nAssessor Notes:\n${assessorNotes}\n\nEvidence:\n${docContent.text}`, attachments: docContent.attachments }
    ], `${tag}_reviewer`);
    log(`[${tag} REVIEWER]:\n${reviewerNotes}\n`);

    // Step 3: Endorser — per-document verdict
    const verdictJson = await this.chat(this.judge, [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT + '\n\n' + DOCUMENT_LEVEL_INSTRUCTIONS + '\n\n' + guides },
      { role: 'user', content: `Document: ${docName} (Section: ${sectionName})\nAssessor Notes:\n${assessorNotes}\n\nReviewer Notes:\n${reviewerNotes}\n\nVerdict for this document only.` }
    ], `${tag}_endorser`, {
      responseFormat: {
        type: 'json_object',
        schema: {
          type: 'object',
          properties: {
            decision: { type: 'string', enum: ['SATISFACTORY', 'UNSATISFACTORY'] },
            justification: { type: 'string' }
          },
          required: ['decision', 'justification']
        }
      }
    });

    let parsed: { decision: 'SATISFACTORY' | 'UNSATISFACTORY'; justification: string } =
      { decision: 'UNSATISFACTORY', justification: 'Failed to parse document verdict.' };
    try {
      parsed = JSON.parse(verdictJson);
    } catch {
      if (verdictJson.includes('SATISFACTORY') && !verdictJson.includes('UNSATISFACTORY')) {
        parsed.decision = 'SATISFACTORY';
      }
    }
    log(`[${tag} ENDORSER]: ${parsed.decision} — ${parsed.justification}\n`);
    return { decision: parsed.decision, notes: assessorNotes + '\n\nReviewer:\n' + reviewerNotes, justification: parsed.justification };
  }

  private async synthesizeSection(
    sectionName: string,
    docResults: Array<{ docName: string; decision: 'SATISFACTORY' | 'UNSATISFACTORY'; notes: string; justification: string }>,
    context: string,
    guides: string,
    log: (msg: string) => void
  ): Promise<{ decision: 'ENDORSED' | 'NOT ENDORSED'; justification: string; notes: string }> {
    log(`--- Synthesizing section: ${sectionName} (${docResults.length} doc(s)) ---`);
    const docSummaries = docResults.map(r =>
      `Document: ${r.docName}\nVerdict: ${r.decision}\nJustification: ${r.justification}\nNotes:\n${r.notes}`
    ).join('\n\n---\n\n');

    // Step 1: Assessor
    const assessorNotes = await this.chat(this.reviewer, [
      { role: 'system', content: REVIEWER_SYSTEM_PROMPT + '\n\n' + SECTION_SYNTHESIS_INSTRUCTIONS + '\n\n' + guides },
      { role: 'user', content: `Section: ${sectionName}\nContext:\n${context}\n\nPer-Document Verdicts:\n${docSummaries}` }
    ], `${sectionName}_section_assessor`);
    log(`[${sectionName} SECTION ASSESSOR]:\n${assessorNotes}\n`);

    // Step 2: Reviewer
    const reviewerNotes = await this.chat(this.adversary, [
      { role: 'system', content: ADVERSARY_SYSTEM_PROMPT + '\n\n' + SECTION_SYNTHESIS_INSTRUCTIONS + '\n\n' + guides },
      { role: 'user', content: `Section: ${sectionName}\nContext:\n${context}\n\nAssessor Section Notes:\n${assessorNotes}\n\nPer-Document Verdicts:\n${docSummaries}` }
    ], `${sectionName}_section_reviewer`);
    log(`[${sectionName} SECTION REVIEWER]:\n${reviewerNotes}\n`);

    // Step 3: Endorser
    const verdictJson = await this.chat(this.judge, [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT + '\n\n' + SECTION_SYNTHESIS_INSTRUCTIONS + '\n\n' + guides },
      { role: 'user', content: `Section: ${sectionName}\nAssessor Notes:\n${assessorNotes}\n\nReviewer Notes:\n${reviewerNotes}\n\nFinal verdict for this section.` }
    ], `${sectionName}_section_endorser`, {
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

    let parsed: { decision: 'ENDORSED' | 'NOT ENDORSED'; justification: string } =
      { decision: 'NOT ENDORSED', justification: 'Failed to parse section verdict.' };
    try {
      parsed = JSON.parse(verdictJson);
    } catch {
      if (verdictJson.includes('ENDORSED') && !verdictJson.includes('NOT ENDORSED')) {
        parsed.decision = 'ENDORSED';
      }
    }
    log(`[${sectionName} SECTION ENDORSER]: ${parsed.decision}\n`);
    return { decision: parsed.decision, justification: parsed.justification, notes: assessorNotes };
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
    log(`Starting Granular Tech Nation assessment for ${candidateName}`);
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

    // Helper: update assessment object from a section result
    const updateAssessment = (moduleName: string, result: { decision: 'ENDORSED' | 'NOT ENDORSED', justification: string, notes: string }) => {
      const isMet = result.decision === 'ENDORSED';
      if (moduleName === 'MANDATORY') {
        assessment.mandatoryCriteria.met = isMet;
        assessment.mandatoryCriteria.justification = result.notes;
      } else if (moduleName.startsWith('OC')) {
        assessment.optionalCriteria.push({ id: moduleName, name: moduleName, description: '', met: isMet, justification: result.notes, evidenceReference: [] });
      } else if (moduleName === 'ELIGIBILITY') {
        // No longer auto-detecting here to avoid brittle overwrites
      }
    };

    // Helper: assess every document in a section individually, then synthesize section verdict
    const assessSection = async (
      sectionName: string,
      context: string
    ): Promise<{ decision: 'ENDORSED' | 'NOT ENDORSED'; justification: string; notes: string } | null> => {
      const segment = segments[sectionName];
      if (!segment?.text.trim()) return null;
      const docs = this.splitSectionIntoDocuments(segment.text, segment.attachments);
      if (docs.length === 0) return null;

      log(`=== Section: ${sectionName} — assessing ${docs.length} document(s) individually ===`);
      const docResults: Array<{ docName: string; decision: 'SATISFACTORY' | 'UNSATISFACTORY'; notes: string; justification: string }> = [];
      for (const doc of docs) {
        const r = await this.assessDocument(doc.name, sectionName, { text: doc.text, attachments: doc.attachments }, context, combinedGuides, log);
        docResults.push({ docName: doc.name, ...r });
      }
      return this.synthesizeSection(sectionName, docResults, context, combinedGuides, log);
    };

    // Cumulative context builder — joins notes from previously assessed sections
    const ctx = (...results: (({ notes: string } | null | undefined))[]) =>
      results.filter(Boolean).map(r => r!.notes).filter(Boolean).join('\n') + '\n\n' + manifest;

    // ── Phase 1: ELIGIBILITY ──────────────────────────────────────────────────
    const eligibilityResult = await assessSection('ELIGIBILITY', `Candidate: ${candidateName}\nTarget Pathway: ${specifiedPathway || 'Unknown'}\n\n${manifest}`)
      ?? { decision: 'NOT ENDORSED' as const, justification: 'No eligibility documents provided.', notes: '' };
    updateAssessment('ELIGIBILITY', eligibilityResult);

    // ── Phase 2: LETTERS ──────────────────────────────────────────────────────
    const lettersResult = await assessSection('LETTERS', ctx(eligibilityResult))
      ?? { decision: 'NOT ENDORSED' as const, justification: 'No recommendation letters provided.', notes: 'No recommendation letters provided.' };
    updateAssessment('LETTERS', lettersResult);

    // ── Phase 3: MANDATORY ────────────────────────────────────────────────────
    const mcResult = await assessSection('MANDATORY', ctx(eligibilityResult, lettersResult))
      ?? { decision: 'NOT ENDORSED' as const, justification: 'No evidence provided for Mandatory Criterion.', notes: 'No evidence provided for Mandatory Criterion.' };
    updateAssessment('MANDATORY', mcResult);

    // ── Phase 4: OC1 ──────────────────────────────────────────────────────────
    const oc1Result = await assessSection('OC1', ctx(eligibilityResult, lettersResult, mcResult));
    if (oc1Result) updateAssessment('OC1', oc1Result);

    // ── Phase 5: OC2 ──────────────────────────────────────────────────────────
    const oc2Result = await assessSection('OC2', ctx(eligibilityResult, lettersResult, mcResult, oc1Result));
    if (oc2Result) updateAssessment('OC2', oc2Result);

    // ── Phase 6: OC3 ──────────────────────────────────────────────────────────
    const oc3Result = await assessSection('OC3', ctx(eligibilityResult, lettersResult, mcResult, oc1Result, oc2Result));
    if (oc3Result) updateAssessment('OC3', oc3Result);

    // ── Phase 7: OC4 ──────────────────────────────────────────────────────────
    const oc4Result = await assessSection('OC4', ctx(eligibilityResult, lettersResult, mcResult, oc1Result, oc2Result, oc3Result));
    if (oc4Result) updateAssessment('OC4', oc4Result);

    // ── Application-level synthesis (Assessor → Reviewer → Endorser) ─────────
    log('=== Application-Level Synthesis ===');
    const historyText = [
      `ELIGIBILITY: ${eligibilityResult.notes}`,
      `LETTERS: ${lettersResult.notes}`,
      `MC: ${mcResult.notes}`,
      oc1Result ? `OC1: ${oc1Result.notes}` : '',
      oc2Result ? `OC2: ${oc2Result.notes}` : '',
      oc3Result ? `OC3: ${oc3Result.notes}` : '',
      oc4Result ? `OC4: ${oc4Result.notes}` : ''
    ].filter(Boolean).join('\n\n');

    // App Assessor
    const appAssessorNotes = await this.chat(this.reviewer, [
      { role: 'system', content: REVIEWER_SYSTEM_PROMPT + '\n\n' + combinedGuides },
      { role: 'user', content: `Candidate: ${candidateName}\n\nSection assessment results:\n${historyText}\n\nProvide a holistic application-level assessment.` }
    ], 'app_assessor');
    log(`[APPLICATION ASSESSOR]:\n${appAssessorNotes}\n`);

    // App Reviewer
    const appReviewerNotes = await this.chat(this.adversary, [
      { role: 'system', content: ADVERSARY_SYSTEM_PROMPT + '\n\n' + combinedGuides },
      { role: 'user', content: `Candidate: ${candidateName}\n\nApplication Assessor Notes:\n${appAssessorNotes}\n\nSection results:\n${historyText}` }
    ], 'app_reviewer');
    log(`[APPLICATION REVIEWER]:\n${appReviewerNotes}\n`);

    // App Endorser — final verdict
    const finalDecisionText = await this.chat(this.judge, [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT + '\n\n' + combinedGuides },
      { role: 'user', content: `Candidate: ${candidateName}\n\nAssessor Notes:\n${appAssessorNotes}\n\nReviewer Notes:\n${appReviewerNotes}\n\nProvide the final application verdict.` }
    ], 'app_endorser', {
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
        const parsed = JSON.parse(finalDecisionText.substring(jsonStart, jsonEnd));
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
      assessment.summary = finalDecisionText || 'Holistic assessment complete.';
      log(`[FINAL DECISION (FALLBACK)]: ${assessment.overallVerdict}`);
    }

    // Safety override: MC or Letters failure forces NOT ENDORSED
    if (!assessment.mandatoryCriteria.met || lettersResult.decision === 'NOT ENDORSED') {
      assessment.overallVerdict = 'NOT ENDORSED';
      log(`[OVERRIDE]: NOT ENDORSED — Mandatory Criteria or Letters not satisfied.`);
    }

    assessment.usage = this.totalUsage;
    assessment.totalCostUSD = this.totalCostUSD;
    return assessment;
  }
}
