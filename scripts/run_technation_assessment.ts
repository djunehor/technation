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
    console.error('Example: tsx scripts/run_technation_assessment.ts ./TECHNATION/Draft "Exceptional Talent" "OC2, OC3"');
    process.exit(1);
  }

  Logger.setLogFile('technation.log');
  Logger.info('Starting Tech Nation Assessment CLI...');

  const agent = new TechnationAgent();
  await agent.initialize();

  let applicationText = '';
  let candidateName = '';

  const stats = fs.lstatSync(applicationPath);

  if (stats.isDirectory()) {
    candidateName = path.basename(applicationPath);
    // Use recursive readdir to find all files in subfolders
    const allEntries = fs.readdirSync(applicationPath, { recursive: true }) as string[];
    const files = allEntries.filter(f => {
      const fullPath = path.join(applicationPath, f);
      return fs.lstatSync(fullPath).isFile() && (f.endsWith('.pdf') || f.endsWith('.docx'));
    });

    for (const file of files) {
      console.log(`Processing ${file}...`);
      const fullPath = path.join(applicationPath, file);
      let result;
      if (file.endsWith('.pdf')) {
        result = await convertPdfToText(fullPath);
      } else {
        result = await convertDocxToText(fullPath);
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
    } else if (applicationPath.endsWith('.docx')) {
      result = await convertDocxToText(applicationPath);
    } else {
      console.error(`❌ Unsupported file format: ${path.extname(applicationPath)}`);
      process.exit(1);
    }
    applicationText = result.text;
  }

  const result = await agent.assess(candidateName, applicationText, {
    pathway: specifiedPathway,
    targetCriteria,
    onUpdate: (msg) => console.log(`[PROGRESS] ${msg}`)
  });

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
