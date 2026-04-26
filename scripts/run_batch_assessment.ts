import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import { TechnationAgent } from '../src/technation/TechnationAgent.js';
import { assessmentStore } from '../src/server/assessmentStore.js';
import { convertPdfToText } from '../src/converters/PdfConverter.js';
import { convertDocxToText } from '../src/converters/DocxConverter.js';
import { Logger } from '../src/utils/logger.js';
import db from '../src/server/database.js';

const TEMP_OCR_DIR = '/Users/djunehor/Sites/technation/scratch/temp_ocr';

async function processApplication(applicationPath: string) {
  const isDir = fs.lstatSync(applicationPath).isDirectory();
  const candidateName = isDir ? path.basename(applicationPath) : path.basename(applicationPath, path.extname(applicationPath));
  const assessmentId = `batch-${uuidv4().substring(0, 8)}-${candidateName.toLowerCase().replace(/\s+/g, '-')}`;

  console.log(`\n🚀 Starting assessment for: ${candidateName} (ID: ${assessmentId})`);
  
  assessmentStore.createAssessment(assessmentId, candidateName);
  assessmentStore.updateStatus(assessmentId, 'processing');
  assessmentStore.addLog(assessmentId, `Starting batch assessment for ${candidateName}`);

  try {
    let fullText = '';
    const agent = new TechnationAgent();
    await agent.initialize();

    const attachments: import('../src/types/index.js').LLMAttachment[] = [];
    if (isDir) {
      const allEntries = fs.readdirSync(applicationPath, { recursive: true }) as string[];
      const files = allEntries.filter(f => {
        const fullPath = path.join(applicationPath, f);
        return fs.lstatSync(fullPath).isFile() && (f.endsWith('.pdf') || f.endsWith('.docx'));
      });

      // Deduplicate: if both .docx and .pdf exist for the same name, prefer .docx
      const docxFiles = files.filter(f => f.endsWith('.docx'));
      const filteredFiles = files.filter(f => {
        if (f.endsWith('.pdf')) {
          const base = f.replace('.pdf', '');
          if (docxFiles.some(df => df.replace('.docx', '') === base)) return false;
        }
        return true;
      });

      for (const file of filteredFiles) {
        const fullPath = path.join(applicationPath, file);
        assessmentStore.addLog(assessmentId, `Processing ${file}...`);
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
        fullText += `### DOCUMENT: ${file}\n${result.text}\n\n`;
      }
    } else {
      assessmentStore.addLog(assessmentId, `Processing ${path.basename(applicationPath)}...`);
      let result;
      if (applicationPath.endsWith('.pdf')) {
        result = await convertPdfToText(applicationPath);
        attachments.push({ type: 'file', mimeType: 'application/pdf', path: applicationPath });
      } else if (applicationPath.endsWith('.docx')) {
        result = await convertDocxToText(applicationPath);
        if (result.attachments) {
          attachments.push(...result.attachments);
        }
      } else {
        throw new Error(`Unsupported file format: ${path.extname(applicationPath)}`);
      }
      fullText = result.text;
    }

    const result = await agent.assess(candidateName, fullText, {
      attachments,
      onUpdate: (msg) => {
        assessmentStore.addLog(assessmentId, msg);
        console.log(`[${candidateName}] ${msg}`);
      }
    });

    assessmentStore.updateStatus(assessmentId, 'completed', result);
    assessmentStore.addLog(assessmentId, 'Assessment complete.');
    console.log(`✅ Assessment complete for ${candidateName}`);

    // Also write to scratch for easy access
    const reportPathMd = `./scratch/assessment_${candidateName}_${Date.now()}.md`;
    let md = `# Tech Nation Assessment Report: ${candidateName}\n`;
    md += `**Verdict:** ${result.overallVerdict === 'ENDORSED' ? '✅ ENDORSED' : '❌ NOT ENDORSED'}\n\n`;
    md += `## Summary\n${result.summary}\n\n`;
    md += `## Criteria\n### Mandatory Criteria (MC)\n**Status:** ${result.mandatoryCriteria.met ? '✅ MET' : '❌ NOT MET'}\n${result.mandatoryCriteria.justification}\n\n`;
    for (const oc of result.optionalCriteria) {
      md += `### ${oc.name}\n**Status:** ${oc.met ? '✅ MET' : '❌ NOT MET'}\n${oc.justification}\n\n`;
    }
    fs.writeFileSync(reportPathMd, md);

  } catch (error: any) {
    console.error(`❌ Failed to process ${candidateName}:`, error);
    assessmentStore.updateStatus(assessmentId, 'failed');
    assessmentStore.addLog(assessmentId, `ERROR: ${error.message}`);
  }
}

async function main() {
  Logger.setLogFile('batch_assessment.log');
  Logger.info('Starting Batch Tech Nation Assessment...');

  // Clear DB first
  console.log('🧹 Wiping database for a clean start...');
  db.prepare('DELETE FROM logs').run();
  db.prepare('DELETE FROM assessments').run();

  if (!fs.existsSync(TEMP_OCR_DIR)) {
    console.error(`Directory not found: ${TEMP_OCR_DIR}`);
    process.exit(1);
  }

  const entries = fs.readdirSync(TEMP_OCR_DIR);
  const validEntries = entries.filter(e => !e.startsWith('.'));

  console.log(`Found ${validEntries.length} applications to assess.`);

  // Process sequentially to avoid overloading LLM/Memory
  for (const entry of validEntries) {
    const fullPath = path.join(TEMP_OCR_DIR, entry);
    await processApplication(fullPath);
  }

  console.log('\n✨ All batch assessments completed!');
}

main().catch(console.error);
