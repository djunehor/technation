import type { ConversionResult } from '../types/index.js';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import Tesseract from 'tesseract.js';

/**
 * Converts a PDF file to plain text using pdftotext (poppler-utils).
 * Falls back to Tesseract OCR (via tesseract.js) if the PDF contains no extractable text (e.g. scanned images).
 */
export async function convertPdfToText(filePath: string): Promise<ConversionResult> {
  const warnings: string[] = [];
  const SCRATCH_DIR = path.resolve(process.cwd(), 'scratch/temp_ocr');

  if (!fs.existsSync(SCRATCH_DIR)) {
    fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  }

  // 1. Get page count
  const infoResult = spawnSync('pdfinfo', [filePath], { encoding: 'utf-8' });
  const pageCountMatch = infoResult.stdout?.match(/Pages:\s+(\d+)/);
  const pageCount = pageCountMatch ? parseInt(pageCountMatch[1], 10) : 1;

  let fullText = '';
  let ocrUsed = false;

  for (let p = 1; p <= pageCount; p++) {
    // Try extracting text for this page
    const pageResult = spawnSync('pdftotext', ['-layout', '-nopgbrk', '-f', String(p), '-l', String(p), filePath, '-'], {
      encoding: 'utf-8'
    });
    
    let pageText = pageResult.stdout?.trim() || '';
    
    // If page is sparse, try OCR for this page specifically
    if (pageText.length < 200) {
      try {
        const tempImgBase = path.join(SCRATCH_DIR, `page_${p}_${Date.now()}`);
        const renderResult = spawnSync('pdftoppm', [
          '-png', '-singlefile', '-f', String(p), '-l', String(p), '-r', '200', filePath, tempImgBase
        ]);

        if (renderResult.status === 0) {
          const imgPath = `${tempImgBase}.png`;
          if (fs.existsSync(imgPath)) {
            const ocrResult = await Tesseract.recognize(imgPath, 'eng');
            const ocrText = ocrResult.data.text?.trim() || '';
            
            if (ocrText.length > pageText.length) {
              pageText = ocrText;
              ocrUsed = true;
            }
            fs.unlinkSync(imgPath);
          }
        }
      } catch (err) {
        warnings.push(`Page ${p} OCR failed: ${(err as Error).message}`);
      }
    }
    
    fullText += `\n--- Page ${p} ---\n${pageText}\n`;
  }

  if (ocrUsed) {
    warnings.push('Some pages appeared to be scans and were captured via OCR (tesseract.js).');
  }

  return {
    text: fullText.trim(),
    originalFormat: 'pdf',
    pageCount,
    warnings,
  };
}
