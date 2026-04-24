# Tech Nation Assessor Agent 🤖💼

An autonomous, "merit-first" visa assessment agent designed to perform forensic document analysis with human-standard rigor. This tool evaluates Tech Nation Global Talent Visa evidence (PDFs and Word documents) through a skeptical peer-review model to identify eligibility risks and evidence chain integrity.

## 🌟 Key Features

- **Forensic Document Analysis**: Deep extraction and processing of PDF and DOCX files.
- **Hybrid OCR**: Falls back to Tesseract OCR and `pdftoppm` for scanned/image-heavy documents.
- **Skeptical Peer-Review Logic**: Multi-step LLM reasoning that challenges "evidence chains" to ensure audit-proof submissions.
- **Multi-Provider Support**: Seamlessly switch between **Gemini 3 Flash**, **GPT-4o**, and **Claude 3 Opus**.
- **Automated PDF Conversion**: Utility scripts to prepare evidence by converting all drafting materials to professional PDFs.
- **Production Ready**: Full ESM support, robust retry logic with exponential backoff, and strict TypeScript implementation.

## 🚀 Getting Started

### Prerequisites

- **Node.js**: v20 or higher (v22 recommended)
- **External Tools** (for PDF/OCR):
  - `pdftoppm` (poppler-utils)
  - `tesseract`
  - `pandoc` (for document conversion)
  - `Google Chrome` (for PDF generation)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/djunehor/technation.git
   cd technation
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure your environment:
   ```bash
   cp .env.example .env # Or create a .env file
   ```
   Add your API keys for Gemini, OpenAI, or Anthropic.

### Building the Project

```bash
npm run build
```

## 🛠️ Usage

### Run an Assessment
To analyze an applicant's evidence folder:
```bash
npm run assess
```

### Convert Drafts to PDF
To batch-convert all `.docx` evidence in the `TECHNATION/Draft` folder:
```bash
npx tsx scripts/convert_folder_to_pdf.ts
```

### Extract Guidelines
To parse the latest Tech Nation assessment guides:
```bash
npm run extract-guides
```

## 🌐 Deployment

The project is designed to be deployed to a Linux/Mac server. Standard deployment path: `/var/www/technation`.

```bash
# Sync files to production
rsync -avz --exclude 'node_modules' ./ user@your-server:/var/www/technation/

# Install production dependencies on server
npm install --omit=dev
```

## 🛡️ Identity & Policy

- **Agent Name**: Technia
- **Developer**: Shagital Tech Ltd
- **Role**: Skeptical Peer Reviewer / Chief Assessor

## 📄 License

Proprietary - Shagital Tech Ltd.
