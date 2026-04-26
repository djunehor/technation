import mammoth from 'mammoth';
import { ConversionResult } from '../types/index.js';
import fs from 'fs';
import path from 'path';

export async function convertDocxToText(filePath: string): Promise<ConversionResult & { attachments?: any[] }> {
    try {
        const buffer = fs.readFileSync(filePath);
        const result = await mammoth.extractRawText({ buffer });
        
        // Extract images for multimodal analysis
        const attachments: any[] = [];
        const { spawnSync } = await import('child_process');
        const tempDir = `./scratch/docx_media_${path.basename(filePath, '.docx')}_${Date.now()}`;
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        // Unzip media files
        spawnSync('unzip', ['-j', filePath, 'word/media/*', '-d', tempDir]);
        
        if (fs.existsSync(tempDir)) {
          const mediaFiles = fs.readdirSync(tempDir);
          for (const file of mediaFiles) {
            attachments.push({
              type: 'file',
              mimeType: file.endsWith('.png') ? 'image/png' : 'image/jpeg',
              path: path.join(tempDir, file)
            });
          }
        }

        return {
            text: result.value,
            originalFormat: 'docx',
            warnings: result.messages.map(m => m.message),
            attachments
        } as any;
    } catch (error: any) {
        return {
            text: `[DOCX EXTRACTION FAILED: ${error.message}]`,
            originalFormat: 'docx',
            warnings: [error.message]
        };
    }
}
