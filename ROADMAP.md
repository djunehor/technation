# Project Roadmap

This document outlines planned technical improvements and feature additions for the Tech Nation Assessor Agent.

Estimated total planned effort: **24 hours**.

---

### Phase 1: Document Ingestion and OCR Enhancements (6 Hours)
- Add streaming PDF parser for large multi-page documents (2 hours).
- Implement tabular data extractor for compensation and financial exhibits (2 hours).
- Add image pre-filtering to bypass blank or corrupted pages prior to OCR processing (2 hours).

### Phase 2: Evidence Chain and Criteria Verification (8 Hours)
- Implement timeline validation engine to detect date discrepancies across letters of reference (3 hours).
- Add cross-reference validator between applicant resume milestones and submitted evidence pieces (3 hours).
- Build automated scoring matrix to check compliance with mandatory and optional criteria rules (2 hours).

### Phase 3: Reporting and Interactive Review Interface (6 Hours)
- Build export module for comprehensive assessment reports in Markdown and PDF formats (2 hours).
- Develop local web review interface displaying risk flags and document previews (2 hours).
- Add configurable confidence thresholds for LLM peer-review responses (2 hours).

### Phase 4: Testing and Continuous Integration (4 Hours)
- Implement automated unit tests for evidence classification and guideline parsing (2 hours).
- Configure GitHub Actions CI workflow to run test suites and type-checking on push (2 hours).
