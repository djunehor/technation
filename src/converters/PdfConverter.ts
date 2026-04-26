import type { ConversionResult } from '../types/index.js';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Converts a PDF file to plain text using pdftotext (poppler-utils).
 * Falls back to Tesseract OCR if the PDF contains no extractable text (e.g. scanned images).
 */
export async function convertPdfToText(filePath: string): Promise<ConversionResult> {
  const warnings: string[] = [];
  const SCRATCH_DIR = 'scratch/temp_ocr';

  if (!fs.existsSync(SCRATCH_DIR)) {
    fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  }

  // 1. Try pdftotext first (most reliable for text-based PDFs)
  const pdfResult = spawnSync('pdftotext', ['-layout', '-nopgbrk', filePath, '-'], {
    encoding: 'utf-8'
  });

  let text = pdfResult.stdout?.trim() || '';

  // 2. If text is sparse or mostly URLs, it might be a scanned PDF or a "Print to PDF" with images. Fallback to OCR.
  const urlCount = (text.match(/https?:\/\//g) || []).length;
  const isSparse = text.length < 300 || (urlCount > 0 && text.length / urlCount < 100);

  if (isSparse) {
    try {
      const tempImgBase = path.join(SCRATCH_DIR, `scan_${path.basename(filePath, '.pdf')}_${Date.now()}`);
      
      // Render PDF pages to images
      const renderResult = spawnSync('pdftoppm', [
        '-png', 
        '-r', '200', 
        filePath, 
        tempImgBase
      ]);

      if (renderResult.status !== 0) {
        throw new Error('PDF rendering for OCR failed');
      }

      // Find all rendered images
      const images = fs.readdirSync(SCRATCH_DIR)
        .filter(f => f.startsWith(path.basename(tempImgBase)) && f.endsWith('.png'))
        .sort();

      let ocrText = '';
      for (const img of images) {
        const imgPath = path.join(SCRATCH_DIR, img);
        const tesseractResult = spawnSync('tesseract', [imgPath, 'stdout', '-l', 'eng'], {
          encoding: 'utf-8'
        });
        ocrText += `\n--- OCR Page ---\n${tesseractResult.stdout}\n`;
        fs.unlinkSync(imgPath); // Clean up image
      }

      if (ocrText.trim().length > text.length) {
        text = ocrText;
        warnings.push('Document appeared to be a scan; captured via OCR.');
      }
    } catch (ocrErr) {
      warnings.push(`OCR Fallback failed: ${(ocrErr as Error).message}`);
    }
  }

  return {
    text,
    originalFormat: 'pdf',
    pageCount: 0, // pdftotext doesn't easily give page count in this mode
    warnings,
  };
}
