import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultDataDir = path.join(__dirname, 'data');
const dbPath = path.resolve(process.env.DB_PATH || path.join(defaultDataDir, 'app.db'));
const dataDir = path.dirname(dbPath);

if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    overall_explanation TEXT NOT NULL DEFAULT '',
    question_type TEXT NOT NULL CHECK(question_type IN ('single', 'multi')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    is_correct INTEGER NOT NULL DEFAULT 0 CHECK(is_correct IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL,
    user_id INTEGER,
    title TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    shuffle_questions INTEGER NOT NULL DEFAULT 0 CHECK(shuffle_questions IN (0, 1)),
    question_order_json TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    submitted_at TEXT,
    auto_submitted INTEGER NOT NULL DEFAULT 0 CHECK(auto_submitted IN (0, 1)),
    score INTEGER,
    total_questions INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS attempt_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    selected_answer_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(attempt_id, question_id),
    FOREIGN KEY (attempt_id) REFERENCES attempts(id) ON DELETE CASCADE,
    FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
  );
`);

ensureColumnExists('attempts', 'user_id', 'INTEGER');
ensureColumnExists('questions', 'overall_explanation', "TEXT NOT NULL DEFAULT ''");

function ensureColumnExists(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name);
  if (!columns.includes(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function normalizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    is_active: Number(row.is_active) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const iterations = 120000;
  const derived = crypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256').toString('hex');
  return `pbkdf2$${iterations}$${salt}$${derived}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  if (!Number.isInteger(iterations) || iterations <= 0 || !salt || !expected) return false;

  const actual = crypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256').toString('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

const statements = {
  listExams: db.prepare(`
    SELECT e.*, COUNT(DISTINCT q.id) AS question_count
    FROM exams e
    LEFT JOIN questions q ON q.exam_id = e.id
    GROUP BY e.id
    ORDER BY e.created_at DESC, e.id DESC
  `),
  getExam: db.prepare(`SELECT * FROM exams WHERE id = ?`),
  createExam: db.prepare(`INSERT INTO exams (name, description) VALUES (?, ?)`),
  deleteExam: db.prepare(`DELETE FROM exams WHERE id = ?`),
  listUsers: db.prepare(`
    SELECT id, username, display_name, role, is_active, created_at, updated_at
    FROM users
    ORDER BY role DESC, created_at DESC, id DESC
  `),
  getUserById: db.prepare(`
    SELECT id, username, display_name, role, is_active, created_at, updated_at, password_hash
    FROM users
    WHERE id = ?
  `),
  getUserByUsername: db.prepare(`
    SELECT id, username, display_name, role, is_active, created_at, updated_at, password_hash
    FROM users
    WHERE username = ?
  `),
  createUser: db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, is_active)
    VALUES (?, ?, ?, ?, ?)
  `),
  updateUser: db.prepare(`
    UPDATE users
    SET username = ?, display_name = ?, role = ?, is_active = ?, updated_at = datetime('now')
    WHERE id = ?
  `),
  updateUserPassword: db.prepare(`
    UPDATE users
    SET password_hash = ?, updated_at = datetime('now')
    WHERE id = ?
  `),
  deleteUser: db.prepare(`DELETE FROM users WHERE id = ?`),
  createSession: db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `),
  getSessionByToken: db.prepare(`
    SELECT s.token_hash, s.user_id, s.expires_at, u.id, u.username, u.display_name, u.role, u.is_active
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.is_active = 1
  `),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
  deleteSessionsByUserId: db.prepare(`DELETE FROM sessions WHERE user_id = ?`),
  deleteAttemptsByUserId: db.prepare(`DELETE FROM attempts WHERE user_id = ?`),
  getQuestionForEdit: db.prepare(`
    SELECT q.*,
      (
        SELECT json_group_array(json_object(
          'id', a.id,
          'content', a.content,
          'is_correct', a.is_correct
        ))
        FROM answers a
        WHERE a.question_id = q.id
        ORDER BY a.id ASC
      ) AS answers_json
    FROM questions q
    WHERE q.id = ?
  `),
  listQuestions: db.prepare(`
    SELECT q.*,
      (
        SELECT json_group_array(json_object(
          'id', a.id,
          'content', a.content,
          'is_correct', a.is_correct
        ))
        FROM answers a
        WHERE a.question_id = q.id
        ORDER BY a.id ASC
      ) AS answers_json
    FROM questions q
    WHERE q.exam_id = ?
    ORDER BY q.id ASC
  `),
  createQuestion: db.prepare(`INSERT INTO questions (exam_id, content, overall_explanation, question_type) VALUES (?, ?, ?, ?)`),
  createAnswer: db.prepare(`INSERT INTO answers (question_id, content, is_correct) VALUES (?, ?, ?)`),
  deleteQuestion: db.prepare(`DELETE FROM questions WHERE id = ?`),
  getQuestionBank: db.prepare(`
    SELECT q.*,
      (
        SELECT json_group_array(json_object(
          'id', a.id,
          'content', a.content,
          'is_correct', a.is_correct
        ))
        FROM answers a
        WHERE a.question_id = q.id
        ORDER BY a.id ASC
      ) AS answers_json
    FROM questions q
    WHERE q.exam_id = ?
    ORDER BY q.id ASC
  `),
  createAttempt: db.prepare(`
    INSERT INTO attempts (exam_id, user_id, title, duration_minutes, shuffle_questions, question_order_json, total_questions)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getAttempt: db.prepare(`SELECT * FROM attempts WHERE id = ?`),
  getAttemptWithExam: db.prepare(`
    SELECT a.*, e.name AS exam_name, e.description AS exam_description
    FROM attempts a
    JOIN exams e ON e.id = a.exam_id
    WHERE a.id = ?
  `),
  upsertAttemptAnswer: db.prepare(`
    INSERT INTO attempt_answers (attempt_id, question_id, selected_answer_ids_json)
    VALUES (?, ?, ?)
    ON CONFLICT(attempt_id, question_id)
    DO UPDATE SET selected_answer_ids_json = excluded.selected_answer_ids_json, created_at = datetime('now')
  `),
  listAttemptAnswers: db.prepare(`
    SELECT *
    FROM attempt_answers
    WHERE attempt_id = ?
  `),
  markAttemptSubmitted: db.prepare(`
    UPDATE attempts
    SET submitted_at = ?, ended_at = ?, auto_submitted = ?, score = ?
    WHERE id = ? AND submitted_at IS NULL
  `),
  listPendingAttempts: db.prepare(`
    SELECT *
    FROM attempts
    WHERE submitted_at IS NULL
  `),
};

seedDemoData();
seedDefaultAdmin();

function seedDemoData() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM exams').get().count;
  if (count > 0) return;

  const examId = statements.createExam.run('Lập trình cơ bản', 'Đề mẫu để bắt đầu nhanh').lastInsertRowid;
  const q1 = statements.createQuestion.run(examId, 'Node.js là gì?', 'single').lastInsertRowid;
  statements.createAnswer.run(q1, 'Môi trường chạy JavaScript phía server', 1);
  statements.createAnswer.run(q1, 'Một trình duyệt web', 0);
  statements.createAnswer.run(q1, 'Một cơ sở dữ liệu', 0);
  statements.createAnswer.run(q1, 'Một hệ điều hành', 0);

  const q2 = statements.createQuestion.run(examId, 'Chọn các đặc điểm đúng của SQLite', 'multi').lastInsertRowid;
  statements.createAnswer.run(q2, 'Nhẹ và nhúng trực tiếp', 1);
  statements.createAnswer.run(q2, 'Cần server riêng để chạy', 0);
  statements.createAnswer.run(q2, 'Lưu dữ liệu vào file', 1);
  statements.createAnswer.run(q2, 'Không phù hợp cho ứng dụng nhỏ', 0);
}

function seedDefaultAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (count > 0) return;

  createUser('admin', 'Administrator', process.env.ADMIN_PASSWORD || 'admin123', 'admin');
}

function normalizeQuestion(row) {
  const answers = row.answers_json ? JSON.parse(row.answers_json) : [];
  return {
    id: row.id,
    exam_id: row.exam_id,
    content: row.content,
    overall_explanation: row.overall_explanation || '',
    question_type: row.question_type,
    answers: answers.map((answer) => ({
      id: answer.id,
      content: answer.content,
      is_correct: Number(answer.is_correct) === 1,
    })),
  };
}

export function listExams() {
  return statements.listExams.all();
}

export function getExam(id) {
  return statements.getExam.get(id);
}

export function createExam(name, description) {
  return statements.createExam.run(name, description);
}

export function deleteExam(id) {
  return statements.deleteExam.run(id);
}

export function listUsers() {
  return statements.listUsers.all().map(normalizeUser);
}

export function getUserById(id) {
  return normalizeUser(statements.getUserById.get(id));
}

export function getUserByUsername(username) {
  return normalizeUser(statements.getUserByUsername.get(username));
}

export function createUser(username, displayName, password, role = 'user') {
  const passwordHash = hashPassword(password);
  const result = statements.createUser.run(
    String(username).trim(),
    String(displayName).trim(),
    passwordHash,
    role === 'admin' ? 'admin' : 'user',
    1
  );
  return Number(result.lastInsertRowid);
}

export function updateUser(userId, username, displayName, role, isActive = true) {
  return statements.updateUser.run(
    String(username).trim(),
    String(displayName).trim(),
    role === 'admin' ? 'admin' : 'user',
    isActive ? 1 : 0,
    userId
  );
}

export function updateUserPassword(userId, password) {
  return statements.updateUserPassword.run(hashPassword(password), userId);
}

export function deleteUser(userId) {
  return statements.deleteUser.run(userId);
}

export function authenticateUser(username, password) {
  const user = statements.getUserByUsername.get(username);
  if (!user || Number(user.is_active) !== 1) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return normalizeUser(user);
}

export function createSession(userId, token, expiresAt) {
  return statements.createSession.run(hashToken(token), userId, expiresAt);
}

export function getSessionByToken(token) {
  const row = statements.getSessionByToken.get(hashToken(token));
  if (!row) return null;
  return {
    token_hash: row.token_hash,
    user_id: row.user_id,
    expires_at: row.expires_at,
    user: normalizeUser(row),
  };
}

export function deleteSession(token) {
  return statements.deleteSession.run(hashToken(token));
}

export function deleteSessionsByUserId(userId) {
  return statements.deleteSessionsByUserId.run(userId);
}

export function deleteAttemptsByUserId(userId) {
  return statements.deleteAttemptsByUserId.run(userId);
}

export function listQuestionsForExam(examId) {
  return statements.listQuestions.all(examId).map(normalizeQuestion);
}

export function getQuestionForEdit(questionId) {
  const row = statements.getQuestionForEdit.get(questionId);
  return row ? normalizeQuestion(row) : null;
}

export function createQuestion(examId, content, overallExplanation, questionType, answers) {
  db.exec('BEGIN');
  try {
    const questionInfo = statements.createQuestion.run(examId, content, overallExplanation, questionType);
    const questionId = Number(questionInfo.lastInsertRowid);
    for (const answer of answers) {
      statements.createAnswer.run(questionId, answer.content, answer.is_correct ? 1 : 0);
    }
    db.exec('COMMIT');
    return questionId;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function deleteQuestion(questionId) {
  return statements.deleteQuestion.run(questionId);
}

export function updateQuestion(questionId, examId, content, overallExplanation, questionType, answers) {
  db.exec('BEGIN');
  try {
    const questionInfo = db.prepare(`
      UPDATE questions
      SET content = ?, overall_explanation = ?, question_type = ?
      WHERE id = ? AND exam_id = ?
    `).run(content, overallExplanation, questionType, questionId, examId);

    if (questionInfo.changes === 0) {
      throw new Error('Question not found');
    }

    const existingAnswers = db.prepare(`
      SELECT id
      FROM answers
      WHERE question_id = ?
      ORDER BY id ASC
    `).all(questionId);
    const existingIdSet = new Set(existingAnswers.map((row) => Number(row.id)));
    const keptAnswerIds = new Set();

    for (const answer of answers) {
      if (answer.id) {
        if (!existingIdSet.has(Number(answer.id))) {
          throw new Error('Answer not found');
        }
        db.prepare(`
          UPDATE answers
          SET content = ?, is_correct = ?
          WHERE id = ? AND question_id = ?
        `).run(answer.content, answer.is_correct ? 1 : 0, answer.id, questionId);
        keptAnswerIds.add(Number(answer.id));
      } else {
        const insertInfo = statements.createAnswer.run(questionId, answer.content, answer.is_correct ? 1 : 0);
        keptAnswerIds.add(Number(insertInfo.lastInsertRowid));
      }
    }

    for (const existingId of existingIdSet) {
      if (!keptAnswerIds.has(existingId)) {
        db.prepare(`
          DELETE FROM answers
          WHERE id = ? AND question_id = ?
        `).run(existingId, questionId);
      }
    }

    db.exec('COMMIT');
    return questionInfo.changes;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function createAttempt(examId, title, durationMinutes, shuffleQuestions, userId = null) {
  const questionBank = statements.getQuestionBank.all(examId).map(normalizeQuestion);
  const orderedQuestions = shuffleQuestions ? shuffleArray(questionBank) : questionBank;
  const result = statements.createAttempt.run(
    examId,
    userId,
    title,
    durationMinutes,
    shuffleQuestions,
    JSON.stringify(orderedQuestions.map((question) => question.id)),
    orderedQuestions.length
  );

  return {
    id: Number(result.lastInsertRowid),
    questionCount: orderedQuestions.length,
  };
}

export function getAttempt(id) {
  return statements.getAttempt.get(id);
}

export function getAttemptWithExam(id) {
  return statements.getAttemptWithExam.get(id);
}

export function loadAttemptQuestions(attempt) {
  const questionIds = JSON.parse(attempt.question_order_json);
  const rows = statements.getQuestionBank.all(attempt.exam_id).map(normalizeQuestion);
  const byId = new Map(rows.map((question) => [question.id, question]));
  return questionIds.map((id) => byId.get(id)).filter(Boolean);
}

export function loadAttemptAnswersMap(attemptId) {
  const rows = statements.listAttemptAnswers.all(attemptId);
  const map = new Map();
  for (const row of rows) {
    const parsed = JSON.parse(row.selected_answer_ids_json);
    map.set(
      row.question_id,
      Array.isArray(parsed) ? parsed.map((value) => Number(value)).filter(Number.isFinite) : []
    );
  }
  return map;
}

export function saveAttemptAnswer(attemptId, questionId, selectedAnswerIds) {
  const normalized = Array.isArray(selectedAnswerIds)
    ? selectedAnswerIds.map((value) => Number(value)).filter(Number.isFinite)
    : [];
  statements.upsertAttemptAnswer.run(attemptId, questionId, JSON.stringify(normalized));
}

export function scoreAttempt(attempt, questions, answersMap) {
  let score = 0;
  const details = questions.map((question) => {
    const selectedIds = answersMap.get(question.id) || [];
    const correctIds = question.answers.filter((answer) => answer.is_correct).map((answer) => answer.id);
    const selectedSet = new Set(selectedIds);
    const correctSet = new Set(correctIds);
    const isCorrect =
      selectedIds.length === correctIds.length &&
      selectedIds.every((id) => correctSet.has(id)) &&
      correctIds.every((id) => selectedSet.has(id));
    if (isCorrect) score += 1;
    return {
      ...question,
      selected_answer_ids: selectedIds,
      correct_answer_ids: correctIds,
      correct_choice_count: correctIds.length,
      is_correct: isCorrect,
    };
  });

  return {
    ...attempt,
    score,
    total_questions: questions.length,
    questions: details,
  };
}

export function finalizeAttemptFromStoredAnswers(attemptId, autoSubmitted = false) {
  const attempt = getAttempt(attemptId);
  if (!attempt || attempt.submitted_at) return null;

  const questions = loadAttemptQuestions(attempt);
  const answersMap = loadAttemptAnswersMap(attemptId);
  const scored = scoreAttempt(attempt, questions, answersMap);
  const now = new Date().toISOString();
  statements.markAttemptSubmitted.run(now, now, autoSubmitted ? 1 : 0, scored.score, attemptId);
  return scored;
}

export function getAttemptResult(attemptId) {
  const attempt = getAttemptWithExam(attemptId);
  if (!attempt) return null;
  const questions = loadAttemptQuestions(attempt);
  const answersMap = loadAttemptAnswersMap(attemptId);
  return scoreAttempt(attempt, questions, answersMap);
}

export function isAttemptExpired(attempt) {
  const startedAtMs = Date.parse(String(attempt.started_at).replace(' ', 'T') + 'Z');
  const durationMs = Number(attempt.duration_minutes) * 60 * 1000;
  return Date.now() >= startedAtMs + durationMs;
}

export function autoSubmitExpiredAttempts() {
  const attempts = statements.listPendingAttempts.all();
  for (const attempt of attempts) {
    if (isAttemptExpired(attempt)) {
      finalizeAttemptFromStoredAnswers(attempt.id, true);
    }
  }
}

function shuffleArray(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
