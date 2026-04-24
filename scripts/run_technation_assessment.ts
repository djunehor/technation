import { TechnationAgent } from '../src/technation/TechnationAgent.js';
import { convertPdfToText } from '../src/converters/PdfConverter.js';
import { convertDocxToText } from '../src/converters/DocxConverter.js';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { Logger } from '../src/utils/logger.js';

async function main() {
  const applicationPath = process.argv[2];
  const specifiedPathway = process.argv[3] as 'Exceptional Talent' | 'Exceptional Promise' | undefined;
  const targetCriteria = process.argv[4];
  
  if (!applicationPath) {
    console.error('Usage: tsx scripts/run_technation_assessment.ts <path_to_application_pdf_or_dir> [pathway] [target_criteria]');
    console.error('Example: tsx scripts/run_technation_assessment.ts app.pdf "Exceptional Talent" "OC2, OC3"');
    process.exit(1);
  }

  Logger.setLogFile('technation.log');
  Logger.info('Starting Tech Nation Assessment...');

  const agent = new TechnationAgent();
  await agent.initialize();

  let applicationText = '';
  let candidateName = '';

  if (fs.lstatSync(applicationPath).isDirectory()) {
    candidateName = path.basename(applicationPath);
    const files = fs.readdirSync(applicationPath).filter(f => f.endsWith('.pdf') || f.endsWith('.docx'));
    for (const file of files) {
      console.log(`Processing ${file}...`);
      let result;
      if (file.endsWith('.pdf')) {
        result = await convertPdfToText(path.join(applicationPath, file));
      } else {
        result = await convertDocxToText(path.join(applicationPath, file));
      }
      
      if (result.text.includes('[OCR FAILED') || result.text.includes('[DOCX EXTRACTION FAILED')) {
        const failedPages = result.text.match(/\[(OCR|DOCX EXTRACTION) FAILED.*\]/g);
        console.error(`\n❌ FATAL: Extraction failed for ${file}:\n${failedPages?.join('\n')}`);
        process.exit(1);
      }
      applicationText += `### DOCUMENT: ${file}\n${result.text}\n\n`;
    }
  } else {
    candidateName = path.basename(applicationPath, '.pdf');
    const textPath = path.join('scratch/technation_text', `${candidateName}.txt`);
  
    if (fs.existsSync(textPath)) {
      const cachedText = fs.readFileSync(textPath, 'utf-8');
      if (!cachedText.includes('[OCR FAILED')) {
        console.log(`Using valid cached text for ${applicationPath}...`);
        applicationText = cachedText;
      } else {
        console.log(`Cached text for ${applicationPath} has failures. Re-extracting...`);
      }
    }
    
    if (!applicationText) {
      console.log(`Processing ${applicationPath}...`);
      let result;
      if (applicationPath.endsWith('.pdf')) {
        result = await convertPdfToText(applicationPath);
      } else if (applicationPath.endsWith('.docx')) {
        result = await convertDocxToText(applicationPath);
      } else {
        console.error(`❌ Unsupported file format: ${path.extname(applicationPath)}`);
        process.exit(1);
      }
      applicationText = result.text;
    }

    if (applicationText.includes('[OCR FAILED')) {
      const failedPages = applicationText.match(/\[OCR FAILED for Page \d+\]/g);
      console.error(`\n❌ FATAL: PDF extraction failed for the following pages:\n${failedPages?.join('\n')}`);
      console.error('\nAssessment halted to save credits. Please check the scan quality of these pages.');
      process.exit(1);
    }
  }

  const result = await agent.assess(candidateName, applicationText, specifiedPathway, targetCriteria);

  console.log('\n--- AUDIT TRAIL: ASSESSMENT DEBATE ---\n');
  for (const round of result.rounds) {
    console.log(`\n[ROUND ${round.roundNumber}]`);
    console.log(`--- REVIEWER ---\n${round.reviewerNotes.substring(0, 500)}...\n`);
    console.log(`--- ADVERSARY ---\n${round.adversaryNotes.substring(0, 500)}...\n`);
    console.log(`Consensus: ${round.consensusReached ? '✅' : '❌'}`);
  }

  const reportPathJson = `scratch/assessment_${candidateName}_${Date.now()}.json`;
  const reportPathMd = `scratch/assessment_${candidateName}_${Date.now()}.md`;
  
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
