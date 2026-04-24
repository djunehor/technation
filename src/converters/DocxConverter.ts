
import mammoth from 'mammoth';
import { ConversionResult } from '../types/index.js';
import fs from 'fs';

export async function convertDocxToText(filePath: string): Promise<ConversionResult> {
    try {
        const buffer = fs.readFileSync(filePath);
        const result = await mammoth.extractRawText({ buffer });
        
        return {
            text: result.value,
            originalFormat: 'docx',
            warnings: result.messages.map(m => m.message)
        };
    } catch (error: any) {
        return {
            text: `[DOCX EXTRACTION FAILED: ${error.message}]`,
            originalFormat: 'docx',
            warnings: [error.message]
        };
    }
}
