import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import { Logger } from '../utils/logger.js';

export interface PageMapping {
  [fileName: string]: [number, number]; // [startPage, endPage] (1-indexed, inclusive)
}

/**
 * Splits a single PDF into multiple PDFs based on page mapping.
 * @param inputPdfPath The source PDF file.
 * @param mapping The mapping of new filenames (e.g., 'CV') to their page ranges.
 * @param outputDir The directory to save the split PDFs.
 * @returns An array of absolute paths to the newly created PDF files.
 */
export async function splitPdf(inputPdfPath: string, mapping: PageMapping, outputDir: string): Promise<string[]> {
  const generatedFiles: string[] = [];

  try {
    const existingPdfBytes = fs.readFileSync(inputPdfPath);
    const sourceDoc = await PDFDocument.load(existingPdfBytes);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    for (const [fileName, [startPage, endPage]] of Object.entries(mapping)) {
      try {
        // Ensure pages are within bounds (1-indexed to 0-indexed)
        const totalPages = sourceDoc.getPageCount();
        const startIdx = Math.max(0, startPage - 1);
        const endIdx = Math.min(totalPages - 1, endPage - 1);

        if (startIdx > endIdx) continue;

        const indices: number[] = [];
        for (let i = startIdx; i <= endIdx; i++) {
          indices.push(i);
        }

        const newDoc = await PDFDocument.create();
        const copiedPages = await newDoc.copyPages(sourceDoc, indices);
        copiedPages.forEach(page => newDoc.addPage(page));

        const pdfBytes = await newDoc.save();
        const outPath = path.join(outputDir, `${fileName}.pdf`);
        fs.writeFileSync(outPath, pdfBytes);
        generatedFiles.push(outPath);
        Logger.info(`Created split PDF: ${outPath} (Pages ${startIdx + 1}-${endIdx + 1})`);
      } catch (err: any) {
        Logger.error(`Failed to split section ${fileName}: ${err.message}`);
      }
    }
  } catch (e: any) {
    Logger.error(`Failed to open source PDF for splitting: ${e.message}`);
  }

  return generatedFiles;
}
