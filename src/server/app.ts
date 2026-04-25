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
import { Logger } from '../utils/logger.js';

dotenv.config();

const app = express();
// Increase multer limits just in case, though default is usually fine
const upload = multer({ 
  dest: 'uploads/',
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

const UPLOAD_ROOT = 'uploads';
if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

// 1. Upload & Start Assessment
app.post('/api/assess', upload.array('files'), async (req, res): Promise<any> => {
  const files = req.files as Express.Multer.File[];
  const candidateName = req.body.candidateName || 'Unknown Candidate';
  const pathway = req.body.pathway as 'Exceptional Talent' | 'Exceptional Promise' | undefined;
  
  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  const assessmentId = uuidv4();
  const sessionDir = path.join(UPLOAD_ROOT, assessmentId);
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
          text = result.text;
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
      }

      assessmentStore.addLog(assessmentId, 'Extraction complete. Starting LLM assessment...');

      const agent = new TechnationAgent();
      await agent.initialize();

      const result = await agent.assess(candidateName, fullText, {
        pathway,
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
      // Cleanup files
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
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
