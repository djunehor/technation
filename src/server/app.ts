import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { TechnationAgent } from '../technation/TechnationAgent.js';
import { assessmentStore } from './assessmentStore.js';
import { convertPdfToText } from '../converters/PdfConverter.js';
import { convertDocxToText } from '../converters/DocxConverter.js';
import { splitPdf } from '../converters/PdfSplitter.js';
import { getLLMProvider } from '../llm/ProviderFactory.js';
import { Logger } from '../utils/logger.js';

dotenv.config();

const app = express();
const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

// Increase multer limits just in case, though default is usually fine
const upload = multer({ 
  dest: UPLOAD_ROOT,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB per file
    fieldSize: 100 * 1024 * 1024 // 100MB for text fields
  }
});

app.use(cors());
// Increase Express body limits for large JSON/URL-encoded payloads
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static('public'));


// 1. Upload & Start Assessment
app.post('/api/assess', upload.array('files'), async (req, res): Promise<any> => {
  const files = req.files as Express.Multer.File[];
  const candidateName = req.body.candidateName || 'Unknown Candidate';
  let pathway = req.body.pathway as 'Exceptional Talent' | 'Exceptional Promise' | undefined;
  const assessmentId = uuidv4();
  const sessionDir = path.join(UPLOAD_ROOT, assessmentId);

  const cleanup = () => {
    if (fs.existsSync(sessionDir)) {
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
    }
    // Also cleanup original multer paths if they still exist
    for (const file of files) {
      if (fs.existsSync(file.path)) {
        try { fs.unlinkSync(file.path); } catch (e) {}
      }
    }
  };

  if (!files || files.length === 0) {
    cleanup();
    return res.status(400).json({ error: 'No files uploaded' });
  }

  fs.mkdirSync(sessionDir, { recursive: true });

  assessmentStore.createAssessment(assessmentId, candidateName);

  // Respond immediately with the ID
  res.json({ assessmentId });

  // Process in background
  (async () => {
    try {
      assessmentStore.updateStatus(assessmentId, 'processing');
      assessmentStore.addLog(assessmentId, `Received ${files.length} files. Starting extraction...`);

      let fullText = '';
      const attachments: any[] = [];

      for (const file of files) {
        const destPath = path.join(sessionDir, file.originalname);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        
        fs.renameSync(file.path, destPath);

        assessmentStore.addLog(assessmentId, `Processing ${file.originalname}...`);
        
        let text = '';
        const ext = file.originalname.toLowerCase();
        
        if (ext.endsWith('.pdf')) {
          const result = await convertPdfToText(destPath);
          
          if (result.pageCount && result.pageCount > 3) {
            assessmentStore.addLog(assessmentId, 'Single PDF detected. Using AI to map page ranges for modular splitting...');
            const provider = getLLMProvider();
            const mappingPrompt = `
You are analyzing a single merged Tech Nation application document.
The document text is separated by "--- Page X ---" markers.
Identify the start and end page numbers for the following sections:
- ELIGIBILITY (CV, Personal Statement, Career history)
- LETTERS (Recommendation Letters)
- MANDATORY (Evidence for Mandatory Criterion)
- OC1, OC2, OC3, OC4 (Evidence for Optional Criteria)

Also, categorize the applicant as "Exceptional Talent" (more than 5 years experience) or "Exceptional Promise" (less than 5 years experience) based on the experience indicated in the CV.

Output ONLY a JSON object mapping the section names to an array of [startPage, endPage], plus a "pathway" field. Example:
{
  "ELIGIBILITY": [1, 5],
  "LETTERS": [6, 9],
  "MANDATORY": [10, 15],
  "OC2": [16, 20],
  "pathway": "Exceptional Talent"
}

Document Text:
${result.text}
`;
            try {
              const llmRes = await (provider as any).chat([{ role: 'user', content: mappingPrompt }], []);
              
              const jsonStart = llmRes.content?.indexOf('{') ?? -1;
              const jsonEnd = llmRes.content?.lastIndexOf('}') ?? -1;
              const mappingJson = jsonStart !== -1 ? llmRes.content?.substring(jsonStart, jsonEnd + 1) : '{}';
              const mapping: any = JSON.parse(mappingJson || '{}');
              
              if (mapping.pathway && !pathway) {
                pathway = mapping.pathway;
                assessmentStore.addLog(assessmentId, `[PATHWAY DETECTED] LLM detected pathway: ${pathway}`);
              }

              assessmentStore.addLog(assessmentId, `Obtained page mapping: ${JSON.stringify(mapping)}`);
              
              const splitDir = path.join(sessionDir, `split_${Date.now()}`);
              const splitFiles = await splitPdf(destPath, mapping, splitDir);
              
              if (splitFiles.length > 0) {
                assessmentStore.addLog(assessmentId, `Successfully split into ${splitFiles.length} files. Processing as individual documents...`);
                for (const splitFile of splitFiles) {
                  const splitResult = await convertPdfToText(splitFile);
                  const splitFileName = path.basename(splitFile);
                  fullText += `\n--- DOCUMENT: ${splitFileName} ---\n${splitResult.text}\n`;
                  attachments.push({
                    type: 'file',
                    name: splitFileName,
                    mimeType: 'application/pdf',
                    path: splitFile
                  });
                }
                continue; // Skip the default attachment handling below since we handled the split files
              } else {
                assessmentStore.addLog(assessmentId, '⚠️ Failed to split PDF (0 files returned). Proceeding with single file.');
                text = result.text;
              }
            } catch (err: any) {
              assessmentStore.addLog(assessmentId, `⚠️ Failed to parse mapping JSON or split PDF: ${err.message}. Proceeding with single file.`);
              text = result.text;
            }
          } else {
            text = result.text;
          }
        } else if (ext.endsWith('.docx')) {
          const result = await convertDocxToText(destPath);
          text = result.text;
        } else if (ext.match(/\.(txt|md|csv|json)$/)) {
          text = fs.readFileSync(destPath, 'utf-8');
        } else {
          assessmentStore.addLog(assessmentId, `⚠️ Skipping ${file.originalname}: Binary/Image files are not yet supported for direct text extraction.`);
          text = `[FILE CONTENT SKIPPED: ${file.originalname} (Binary/Image)]`;
        }

        fullText += `\n--- DOCUMENT: ${file.originalname} ---\n${text}\n`;

        // Only pass PDF and Images as attachments to the LLM (multimodal support)
        const isSupportedMultimodal = ext.endsWith('.pdf') || ext.match(/\.(png|jpg|jpeg|webp|heic|heif)$/);
        if (isSupportedMultimodal) {
          attachments.push({
            type: 'file',
            name: file.originalname,
            mimeType: ext.endsWith('.pdf') ? 'application/pdf' : file.mimetype,
            path: destPath
          });
        }
      }

      assessmentStore.addLog(assessmentId, 'Extraction complete. Starting assessment...');

      const agent = new TechnationAgent();
      await agent.initialize();

      const result = await agent.assess(candidateName, fullText, {
        pathway,
        attachments,
        onUpdate: (msg) => {
          assessmentStore.addLog(assessmentId, msg);
        }
      });

      assessmentStore.updateStatus(assessmentId, 'completed', result);
      assessmentStore.addLog(assessmentId, 'Assessment complete.');

    } catch (error: any) {
      Logger.error(`Assessment ${assessmentId} failed:`, error);
      assessmentStore.updateStatus(assessmentId, 'failed');
      assessmentStore.addLog(assessmentId, `ERROR: ${error.message}`);
    } finally {
      cleanup();
    }
  })();
});

// 2. SSE for real-time logs
app.get('/api/assess/:id/stream', (req, res) => {
  const { id } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send existing logs first
  const existingLogs = assessmentStore.getLogs(id);
  existingLogs.forEach(log => {
    res.write(`data: ${JSON.stringify({ type: 'log', message: log.message })}\n\n`);
  });

  const onLog = (message: string) => {
    res.write(`data: ${JSON.stringify({ type: 'log', message })}\n\n`);
  };

  assessmentStore.on(`log:${id}`, onLog);

  req.on('close', () => {
    assessmentStore.off(`log:${id}`, onLog);
  });
});

// 3. Polling for status/result
app.get('/api/assess/:id', (req, res): any => {
  const assessment = assessmentStore.getAssessment(req.params.id);
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });
  return res.json(assessment);
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  Logger.info(`Secure Technia Server running on port ${PORT}`);
});

server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    Logger.error(`❌ Port ${PORT} is already in use. Please kill the existing process or use a different port.`);
  } else {
    Logger.error('❌ Server failed to start:', err);
  }
  process.exit(1);
});
