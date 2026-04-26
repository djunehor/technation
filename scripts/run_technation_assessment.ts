import { TechnationAgent } from '../src/technation/TechnationAgent.js';
import { convertPdfToText } from '../src/converters/PdfConverter.js';
import { convertDocxToText } from '../src/converters/DocxConverter.js';
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
      attachments.push({ type: 'file', mimeType: 'application/pdf', path: applicationPath });
    } else if (applicationPath.endsWith('.docx')) {
      result = await convertDocxToText(applicationPath);
    } else {
      console.error(`❌ Unsupported file format: ${path.extname(applicationPath)}`);
      process.exit(1);
    }
    applicationText = result.text;
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
  
  fs.writeFileSync(reportPathMd, md);
  
  console.log(`\n✅ Assessment Complete!`);
  console.log(`Human-readable report: ${reportPathMd}`);
  console.log(`Raw data (JSON): ${reportPathJson}`);
}

main().catch(console.error);
