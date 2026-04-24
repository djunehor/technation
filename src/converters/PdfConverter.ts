import type { ConversionResult } from '../types/index.js';
import { createCanvas, Image } from 'canvas';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Converts a PDF file to plain text by extracting all text items across all pages.
 * If text extraction fails (scanned PDF), it falls back to EasyOCR (Local Python Bridge).
 */
export async function convertPdfToText(filePath: string): Promise<ConversionResult> {
  const warnings: string[] = [];
  const SCRATCH_DIR = 'scratch/temp_ocr';

  if (!fs.existsSync(SCRATCH_DIR)) {
    fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  }

  // Dynamic imports to manage ESM environment
  const pdfjs = await import('pdfjs-dist');
  const { getDocument, GlobalWorkerOptions } = pdfjs;
  GlobalWorkerOptions.workerSrc = '';
  (GlobalWorkerOptions as any).Image = Image;
  // Set polyfills for Node.js rendering
  (GlobalWorkerOptions as any).canvasFactory = {
    create(width: number, height: number) {
      const canvas = createCanvas(width, height);
      return {
        canvas,
        context: canvas.getContext('2d'),
      };
    },
    reset(canvasAndContext: any, width: number, height: number) {
      canvasAndContext.canvas.width = width;
      canvasAndContext.canvas.height = height;
    },
    destroy(canvasAndContext: any) {
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
      canvasAndContext.canvas = null;
      canvasAndContext.context = null;
    },
  };

  const pdfjsPath = path.dirname(import.meta.resolve('pdfjs-dist').replace('file://', ''));
  // Point to the correct standard_fonts directory
  const standardFontDataUrl = path.join(pdfjsPath, '..', 'standard_fonts', '/');

  const doc = await getDocument({ 
    url: filePath, 
    useWorkerFetch: false, 
    isEvalSupported: false,
    standardFontDataUrl
  }).promise;
  const pageCount = doc.numPages;
  const pageTexts: string[] = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();

    let pageText = '';
    const rowMap = new Map<number, Array<{ x: number; str: string }>>();

    for (const item of textContent.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const ty = Math.round((item.transform as number[])[5]!);
      if (!rowMap.has(ty)) rowMap.set(ty, []);
      rowMap.get(ty)!.push({ x: (item.transform as number[])[4]!, str: item.str });
    }

    // Check for images on the page
    const operatorList = await page.getOperatorList();
    const hasImages = operatorList.fnArray.some((fn: number) => 
      fn === (pdfjs as any).OPS.paintImageXObject || 
      fn === (pdfjs as any).OPS.paintInlineImageXObject
    );

    if (rowMap.size > 0 && !hasImages) {
      const sortedRows = [...rowMap.entries()]
        .sort(([ya], [yb]) => yb - ya)
        .map(([, items]) =>
          items
            .sort((a, b) => a.x - b.x)
            .map((i) => i.str)
            .join(' ')
            .trim()
        )
        .filter(Boolean);
      pageText = sortedRows.join('\n');
    } else {
      // Hybrid Fallback: Render page to image and run Tesseract
      try {
        const tempImgPath = path.join(SCRATCH_DIR, `page_${pageNum}`);
        
        // Use pdftoppm to extract exactly the one page we need
        // -f and -l set the first and last page (same page)
        // -png ensures we get a high-quality image
        // -singlefile prevents it from appending "-1" to the filename
        const renderResult = spawnSync('pdftoppm', [
          '-f', pageNum.toString(), 
          '-l', pageNum.toString(), 
          '-png', 
          '-singlefile', 
          '-r', '200', // 200 DPI is optimal for OCR
          filePath, 
          tempImgPath
        ]);

        const actualImagePath = `${tempImgPath}.png`;
        
        if (renderResult.error || !fs.existsSync(actualImagePath)) {
          throw new Error(`PDF Render failed for page ${pageNum}: ${renderResult.error?.message}`);
        }

        // Run Tesseract OCR
        const ocrResult = spawnSync('tesseract', [actualImagePath, 'stdout', '-l', 'eng+deu'], {
          encoding: 'utf-8'
        });

        if (ocrResult.error) {
          throw new Error(`OCR failed for page ${pageNum}: ${ocrResult.error.message}`);
        }

        pageText = ocrResult.stdout || '';
        warnings.push(`Page ${pageNum} captured via Hybrid OCR (pdftoppm + tesseract).`);
        
        // Clean up
        if (fs.existsSync(actualImagePath)) fs.unlinkSync(actualImagePath);
      } catch (ocrErr) {
        const errMsg = (ocrErr as Error).message;
        console.error(`❌ OCR Error on Page ${pageNum}: ${errMsg}`);
        warnings.push(`Page ${pageNum} OCR failed: ${errMsg}`);
        pageText = `[OCR FAILED for Page ${pageNum}]`;
      }
    }

    pageTexts.push(`--- Page ${pageNum} ---\n${pageText}`);
  }

  await doc.destroy();

  return {
    text: pageTexts.join('\n\n'),
    originalFormat: 'pdf',
    pageCount,
    warnings,
  };
}
