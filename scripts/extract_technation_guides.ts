
import { convertPdfToText } from '../src/converters/PdfConverter.js';
import fs from 'fs';
import path from 'path';

async function main() {
  const files = [
    'Tech Nation - Global Talent Visa Application Guide.pdf',
    'Tech Nation Internal Assessor Guide.pdf',
    'Franklin_Ekoh _proforma.pdf',
    'Zach_Technation_July.pdf'
  ];

  const baseDir = 'TECHNATION';
  const outputDir = 'scratch/technation_text';

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const file of files) {
    const filePath = path.join(baseDir, file);
    console.log(`Extracting ${filePath}...`);
    try {
      const result = await convertPdfToText(filePath);
      const outputName = file.replace('.pdf', '.txt');
      fs.writeFileSync(path.join(outputDir, outputName), result.text);
      console.log(`Saved to ${outputDir}/${outputName}`);
    } catch (error) {
      console.error(`Error extracting ${file}:`, error);
    }
  }
}

main();
