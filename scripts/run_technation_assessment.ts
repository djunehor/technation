import { TechnationAgent } from '../src/technation/TechnationAgent.js';
import { convertPdfToText } from '../src/converters/PdfConverter.js';
import { convertDocxToText } from '../src/converters/DocxConverter.js';
import { splitPdf, PageMapping } from '../src/converters/PdfSplitter.js';
import { getLLMProvider } from '../src/llm/ProviderFactory.js';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { Logger } from '../src/utils/logger.js';
import { assessmentStore } from '../src/server/assessmentStore.js';
import { v4 as uuidv4 } from 'uuid';

async function main() {
  const applicationPath = process.argv[2];
  const specifiedPathway = process.argv[3] as 'Exceptional Talent' | 'Exceptional Promise' | undefined;
  const targetCriteria = process.argv[4];
  
  if (!applicationPath) {
    console.error('Usage: tsx scripts/run_technation_assessment.ts <path_to_application_pdf_or_dir> [pathway] [target_criteria]');
    console.error('Example: tsx scripts/run_technation_assessment.ts ./TECHNATION/Draft "Exceptional Talent" "OC2, OC3"');
    process.exit(1);
  }

  Logger.setLogFile('technation.log');
  Logger.info('Starting Tech Nation Assessment CLI...');

  const agent = new TechnationAgent();
  await agent.initialize();

  const assessmentId = `cli-${uuidv4().substring(0, 8)}`;
  assessmentStore.createAssessment(assessmentId, 'Applicant'); // Temporary name, will update later
  assessmentStore.updateStatus(assessmentId, 'processing');

  let applicationText = '';
  let candidateName = '';
  const attachments: import('../src/types/index.js').LLMAttachment[] = [];

  const stats = fs.lstatSync(applicationPath);

  if (stats.isDirectory()) {
    candidateName = path.basename(applicationPath);
    // Use recursive readdir to find all files in subfolders
    const allEntries = fs.readdirSync(applicationPath, { recursive: true }) as string[];
    const files = allEntries.filter(f => {
      const fullPath = path.join(applicationPath, f);
      return fs.lstatSync(fullPath).isFile() && (f.endsWith('.pdf') || f.endsWith('.docx'));
    });

    // Deduplicate: if both .docx and .pdf exist for the same name, prefer .docx
    const docxFiles = files.filter(f => f.endsWith('.docx'));
    const pdfFiles = files.filter(f => f.endsWith('.pdf'));
    
    const filteredFiles = files.filter(f => {
      if (f.endsWith('.pdf')) {
        const base = f.replace('.pdf', '');
        if (docxFiles.some(df => df.replace('.docx', '') === base)) return false;
      }
      return true;
    });

    for (const file of filteredFiles) {
      console.log(`Processing ${file}...`);
      const fullPath = path.join(applicationPath, file);
      let result;
      if (file.endsWith('.pdf')) {
        result = await convertPdfToText(fullPath);
        attachments.push({ type: 'file', mimeType: 'application/pdf', path: fullPath });
      } else {
        result = await convertDocxToText(fullPath);
        if (result.attachments) {
          attachments.push(...result.attachments);
        }
      }
      
      if (result.text.includes('[OCR FAILED') || result.text.includes('[DOCX EXTRACTION FAILED')) {
        console.warn(`⚠️ Warning: Extraction issues detected in ${file}`);
      }
      applicationText += `### DOCUMENT: ${file}\n${result.text}\n\n`;
    }
  } else {
    candidateName = path.basename(applicationPath, path.extname(applicationPath));
    console.log(`Processing ${applicationPath}...`);
    let result;
    if (applicationPath.endsWith('.pdf')) {
      result = await convertPdfToText(applicationPath);
      
      if (result.pageCount && result.pageCount > 3) {
        console.log('Single PDF detected. Using AI to map page ranges for modular splitting...');
        const provider = getLLMProvider();
        const mappingPrompt = `
You are analyzing a single merged Tech Nation application document.
The document text is separated by "--- Page X ---" markers.
Identify the start and end page numbers for the following sections:
- ELIGIBILITY (CV, Personal Statement, Career history)
- LETTERS (Recommendation Letters)
- MANDATORY (Evidence for Mandatory Criterion)
- OC1, OC2, OC3, OC4 (Evidence for Optional Criteria)

Output ONLY a JSON object mapping the section names to an array of [startPage, endPage].
If a section is missing, do not include it. Example:
{
  "ELIGIBILITY": [1, 5],
  "LETTERS": [6, 9],
  "MANDATORY": [10, 15],
  "OC2": [16, 20]
}

Document Text:
${result.text}
`;
        const llmRes = await provider.chat([{ role: 'user', content: mappingPrompt }], []);
        
        try {
            const jsonStart = llmRes.content?.indexOf('{') ?? -1;
            const jsonEnd = llmRes.content?.lastIndexOf('}') ?? -1;
            const mappingJson = jsonStart !== -1 ? llmRes.content?.substring(jsonStart, jsonEnd + 1) : '{}';
            const mapping: PageMapping = JSON.parse(mappingJson || '{}');
            console.log('Obtained page mapping:', mapping);
            
            const splitDir = path.resolve(process.cwd(), `scratch/split_${candidateName}_${Date.now()}`);
            const splitFiles = await splitPdf(applicationPath, mapping, splitDir);
            
            if (splitFiles.length > 0) {
                console.log(`Successfully split into ${splitFiles.length} files. Processing as directory...`);
                for (const splitFile of splitFiles) {
                    const splitResult = await convertPdfToText(splitFile);
                    attachments.push({ type: 'file', mimeType: 'application/pdf', path: splitFile });
                    applicationText += `\n--- DOCUMENT: ${path.basename(splitFile)} ---\n${splitResult.text}\n\n`;
                }
            } else {
                console.warn('Failed to split PDF. Proceeding with single file.');
                applicationText = `\n--- DOCUMENT: ${path.basename(applicationPath)} ---\n${result.text}`;
                attachments.push({ type: 'file', mimeType: 'application/pdf', path: applicationPath });
            }
        } catch (err: any) {
             console.error('Failed to parse mapping JSON:', err.message);
             applicationText = `\n--- DOCUMENT: ${path.basename(applicationPath)} ---\n${result.text}`;
             attachments.push({ type: 'file', mimeType: 'application/pdf', path: applicationPath });
        }
      } else {
         applicationText = `\n--- DOCUMENT: ${path.basename(applicationPath)} ---\n${result.text}`;
         attachments.push({ type: 'file', mimeType: 'application/pdf', path: applicationPath });
      }
    } else if (applicationPath.endsWith('.docx')) {
      result = await convertDocxToText(applicationPath);
      applicationText = `\n--- DOCUMENT: ${path.basename(applicationPath)} ---\n${result.text}`;
    } else {
      console.error(`❌ Unsupported file format: ${path.extname(applicationPath)}`);
      process.exit(1);
    }
  }

  assessmentStore.addLog(assessmentId, `Starting assessment for ${candidateName}...`);
  
  const result = await agent.assess(candidateName, applicationText, {
    pathway: specifiedPathway,
    targetCriteria,
    attachments,
    onUpdate: (msg) => {
      console.log(`[PROGRESS] ${msg}`);
      assessmentStore.addLog(assessmentId, msg);
    }
  });

  assessmentStore.updateStatus(assessmentId, 'completed', result);

  const reportPathJson = `./scratch/assessment_${candidateName}_${Date.now()}.json`;
  const reportPathMd = `./scratch/assessment_${candidateName}_${Date.now()}.md`;
  
  if (!fs.existsSync('./scratch')) fs.mkdirSync('./scratch', { recursive: true });

  fs.writeFileSync(reportPathJson, JSON.stringify(result, null, 2));
  
  // Generate a clean Markdown report
  let md = `# Tech Nation Assessment Report: ${candidateName}\n`;
  md += `**Verdict:** ${result.overallVerdict === 'ENDORSED' ? '✅ ENDORSED' : '❌ NOT ENDORSED'}\n\n`;
  md += `## Summary\n${result.summary}\n\n`;
  md += `## Criteria\n### Mandatory Criteria (MC)\n**Status:** ${result.mandatoryCriteria.met ? '✅ MET' : '❌ NOT MET'}\n${result.mandatoryCriteria.justification}\n\n`;
  for (const oc of result.optionalCriteria) {
    md += `### ${oc.name}\n**Status:** ${oc.met ? '✅ MET' : '❌ NOT MET'}\n${oc.justification}\n\n`;
  }
  
  // Add detailed feedback from the last round of notes
  const lastRound = result.rounds[result.rounds.length - 1];
  if (lastRound && lastRound.reviewerNotes) {
    md += `## Detailed Assessor Feedback\n${lastRound.reviewerNotes}\n\n`;
  }
  
  fs.writeFileSync(reportPathMd, md);
  
  console.log(`\n✅ Assessment Complete!`);
  console.log(`Human-readable report: ${reportPathMd}`);
  console.log(`Raw data (JSON): ${reportPathJson}`);
}

main().catch(console.error);
