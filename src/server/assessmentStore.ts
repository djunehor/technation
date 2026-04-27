import { EventEmitter } from 'events';
import db from './database.js';

class AssessmentStore extends EventEmitter {
  constructor() {
    super();
  }

  createAssessment(id: string, candidateName: string) {
    db.prepare('INSERT INTO assessments (id, candidate_name) VALUES (?, ?)').run(id, candidateName);
  }

  updateStatus(id: string, status: string, result?: any) {
    if (result) {
      db.prepare('UPDATE assessments SET status = ?, result = ?, candidate_name = ?, input_tokens = ?, output_tokens = ?, cache_hit_tokens = ?, total_cost = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(
          status, 
          JSON.stringify(result), 
          result.candidateName || 'Applicant', 
          result.usage?.inputTokens || 0,
          result.usage?.outputTokens || 0,
          result.usage?.cacheHitTokens || 0,
          result.totalCostUSD || 0,
          id
        );
    } else {
      db.prepare('UPDATE assessments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(status, id);
    }
  }

  addLog(id: string, message: string) {
    db.prepare('INSERT INTO logs (assessment_id, message) VALUES (?, ?)').run(id, message);
    this.emit(`log:${id}`, message);
  }

  getAssessment(id: string) {
    const assessment = db.prepare('SELECT * FROM assessments WHERE id = ?').get(id) as any;
    if (assessment && assessment.result) {
      assessment.result = JSON.parse(assessment.result);
    }
    return assessment;
  }

  getLogs(id: string) {
    return db.prepare('SELECT * FROM logs WHERE assessment_id = ? ORDER BY timestamp ASC').all(id) as any[];
  }
}

export const assessmentStore = new AssessmentStore();
