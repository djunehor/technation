import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const DRAFT_DIR = '/Users/djunehor/Sites/technation/TECHNATION/Draft';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PANDOC_PATH = '/opt/homebrew/bin/pandoc';

async function convertFolder() {
  if (!fs.existsSync(DRAFT_DIR)) {
    console.error(`Directory not found: ${DRAFT_DIR}`);
    return;
  }

  const files = fs.readdirSync(DRAFT_DIR);
  const docxFiles = files.filter(f => f.endsWith('.docx'));

  console.log(`Found ${docxFiles.length} .docx files to convert.`);

  // Create a temporary CSS file for better styling
  const cssPath = path.join(DRAFT_DIR, 'temp_style.css');
  const cssContent = `
    body { 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
      line-height: 1.6; 
      margin: 1in; 
      color: #1a1a1a;
    }
    img { max-width: 100%; height: auto; display: block; margin: 10px 0; }
    h1, h2, h3, h4 { color: #2c3e50; margin-top: 1.5em; }
    p { margin-bottom: 1em; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 1em; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #f2f2f2; }
  `;
  fs.writeFileSync(cssPath, cssContent);

  for (const file of docxFiles) {
    const inputPath = path.join(DRAFT_DIR, file);
    const baseName = path.parse(file).name;
    const htmlPath = path.join(DRAFT_DIR, `${baseName}.html`);
    const pdfPath = path.join(DRAFT_DIR, `${baseName}.pdf`);

    console.log(`📄 Converting: ${file}...`);

    // 1. Docx to HTML via Pandoc
    const pandocResult = spawnSync(PANDOC_PATH, [
      inputPath,
      '-o', htmlPath,
      '-s', // Standalone
      '--css', cssPath,
      '--self-contained' // Embed images in HTML
    ]);

    if (pandocResult.status !== 0) {
      console.error(`❌ Pandoc failed for ${file}: ${pandocResult.stderr.toString()}`);
      continue;
    }

    // 2. HTML to PDF via Chrome
    const chromeResult = spawnSync(CHROME_PATH, [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      `--print-to-pdf=${pdfPath}`,
      htmlPath
    ]);

    if (chromeResult.status !== 0) {
      console.error(`❌ Chrome failed for ${file}: ${chromeResult.stderr.toString()}`);
    } else {
      console.log(`✅ Success: ${baseName}.pdf`);
    }

    // 3. Cleanup HTML
    if (fs.existsSync(htmlPath)) {
      fs.unlinkSync(htmlPath);
    }
  }

  // Final cleanup
  if (fs.existsSync(cssPath)) {
    fs.unlinkSync(cssPath);
  }

  console.log('\n✨ All conversions complete!');
}

convertFolder().catch(err => {
  console.error('Unhandled error during conversion:', err);
  process.exit(1);
});
