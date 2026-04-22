import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import ejs from 'ejs';
import {
  autoSubmitExpiredAttempts,
  authenticateUser,
  createAttempt,
  createExam,
  createQuestion,
  createSession,
  deleteExam,
  deleteQuestion,
  deleteSession,
  deleteAttemptsByUserId,
  deleteSessionsByUserId,
  finalizeAttemptFromStoredAnswers,
  getAttempt,
  getAttemptResult,
  getAttemptWithExam,
  getExam,
  getQuestionForEdit,
  getSessionByToken,
  listAttemptHistory,
  listUsers,
  listExams,
  listQuestionsForExam,
  saveAttemptAnswer,
  isAttemptExpired,
  loadAttemptQuestions,
  loadAttemptAnswersMap,
  createUser,
  updateUser,
  updateUserPassword,
  deleteUser,
  updateQuestion,
} from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const renderFile = promisify(ejs.renderFile);
const viewsDir = path.join(__dirname, 'views');
const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads'));

if (!existsSync(uploadsDir)) {
  mkdirSync(uploadsDir, { recursive: true });
}

app.set('x-powered-by', false);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.locals.currentUser = getCurrentUser(req);
  res.locals.isAdmin = Boolean(res.locals.currentUser && res.locals.currentUser.role === 'admin');
  next();
});

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function tryPrettyJsonContent(value) {
  const text = String(value ?? '');
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

function prettyContent(value) {
  const text = String(value ?? '');
  const trimmed = text.trim();
  if (!trimmed) return '';

  return tryPrettyJsonContent(text) || text;
}

function isSafeImageSrc(src) {
  const trimmed = String(src ?? '').trim();
  return /^(https?:\/\/|\/(?!\/)|data:image\/)/i.test(trimmed);
}

function renderRichContent(value) {
  const text = String(value ?? '');
  const trimmed = text.trim();
  if (!trimmed) return '';

  const prettyJson = tryPrettyJsonContent(text);
  if (prettyJson) {
    return `<div class="rich-content"><pre class="code-block">${escapeHtml(prettyJson)}</pre></div>`;
  }

  const parts = [];
  const imagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match;

  const pushText = (chunk) => {
    if (!chunk) return;
    const escaped = escapeHtml(chunk).replaceAll('\n', '<br />');
    parts.push(`<div class="rich-text">${escaped}</div>`);
  };

  while ((match = imagePattern.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    pushText(before);

    const alt = escapeHtml(match[1] || '');
    const src = String(match[2] || '').trim();
    if (isSafeImageSrc(src)) {
      parts.push(
        `<div class="rich-image-wrap"><img class="rich-image" src="${escapeHtml(src)}" alt="${alt}" loading="lazy" /></div>`
      );
    } else {
      pushText(match[0]);
    }

    lastIndex = match.index + match[0].length;
  }

  pushText(text.slice(lastIndex));

  return `<div class="rich-content">${parts.join('')}</div>`;
}

function parseMultipartUpload(req) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] || '');
    const match = contentType.match(/boundary=([^;]+)/i);
    if (!match) {
      reject(new Error('Missing multipart boundary'));
      return;
    }

    const boundary = Buffer.from(`--${match[1].replace(/^"|"$/g, '')}`);
    const chunks = [];

    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const parts = [];
        let start = body.indexOf(boundary);

        while (start !== -1) {
          start += boundary.length + 2;
          const end = body.indexOf(boundary, start) - 2;
          if (end < start) break;
          parts.push(body.slice(start, end));
          start = body.indexOf(boundary, end + 2);
        }

        const fields = {};
        let file = null;

        for (const part of parts) {
          const separator = part.indexOf(Buffer.from('\r\n\r\n'));
          if (separator === -1) continue;

          const headerText = part.slice(0, separator).toString('utf8');
          const content = part.slice(separator + 4);
          const nameMatch = headerText.match(/name="([^"]+)"/i);
          if (!nameMatch) continue;

          const filenameMatch = headerText.match(/filename="([^"]*)"/i);
          if (filenameMatch && filenameMatch[1]) {
            const typeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);
            file = {
              fieldName: nameMatch[1],
              filename: filenameMatch[1],
              mimeType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
              data: content.slice(0, content.length - 2),
            };
          } else {
            fields[nameMatch[1]] = content.toString('utf8').replace(/\r\n$/, '');
          }
        }

        resolve({ fields, file });
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

function isAllowedImageMime(mimeType) {
  return ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(
    String(mimeType || '').toLowerCase()
  );
}

function extensionForMime(mimeType, filename) {
  const lowerName = String(filename || '').toLowerCase();
  if (lowerName.endsWith('.png')) return '.png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return '.jpg';
  if (lowerName.endsWith('.gif')) return '.gif';
  if (lowerName.endsWith('.webp')) return '.webp';
  if (lowerName.endsWith('.svg')) return '.svg';
  switch (String(mimeType || '').toLowerCase()) {
    case 'image/png': return '.png';
    case 'image/jpeg':
    case 'image/jpg': return '.jpg';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    case 'image/svg+xml': return '.svg';
    default: return '';
  }
}

function createImageMarkdown(url, alt = '') {
  const safeAlt = String(alt || '').trim();
  const label = safeAlt || 'Hình ảnh';
  return `![${label}](${url})`;
}

function decorateQuestion(question) {
  return {
    ...question,
    contentBlock: renderRichContent(question.content),
    overallExplanationBlock: renderRichContent(question.overall_explanation),
    answers: question.answers.map((answer) => ({
      ...answer,
      contentBlock: renderRichContent(answer.content),
    })),
  };
}

function decorateAttempt(attempt) {
  return {
    ...attempt,
    questions: attempt.questions.map((question) => decorateQuestion(question)),
  };
}

function normalizeAnswers(body) {
  return Object.keys(body)
    .filter((key) => /^answer_\d+$/.test(key))
    .map((key) => {
      const index = Number(key.replace('answer_', ''));
      return {
        index,
        content: String(body[key] || '').trim(),
      };
    })
    .filter((item) => item.content)
    .sort((a, b) => a.index - b.index)
    .map((item) => ({
      content: item.content,
      is_correct: parseCorrectAnswerIndexes(body).has(item.index),
    }));
}

function normalizeAnswersWithIds(body) {
  return Object.keys(body)
    .filter((key) => /^answer_\d+$/.test(key))
    .map((key) => {
      const index = Number(key.replace('answer_', ''));
      return {
        index,
        id: body[`answer_id_${index}`] ? Number(body[`answer_id_${index}`]) : null,
        content: String(body[key] || '').trim(),
      };
    })
    .filter((item) => item.content)
    .sort((a, b) => a.index - b.index)
    .map((item) => ({
      id: Number.isInteger(item.id) && item.id > 0 ? item.id : null,
      content: item.content,
      is_correct: parseCorrectAnswerIndexes(body).has(item.index),
    }));
}

function parseCorrectAnswerIndexes(body) {
  const raw = body.correct_answer;
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return new Set(
    values
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  );
}

function hasDuplicateAnswers(answers) {
  const seen = new Set();
  for (const answer of answers) {
    const key = answer.content.trim().toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function parseSelectedIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) {
      return parsed.map(Number).filter(Number.isFinite);
    }
  } catch {
    return String(value)
      .split(',')
      .map((part) => Number(part.trim()))
      .filter(Number.isFinite);
  }
  return [];
}

function parsePositivePage(value) {
  const page = Number.parseInt(String(value || '1'), 10);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function normalizeSelectedAnswerIdsForQuestion(question, selectedIds) {
  if (!question) return [];
  const validAnswerIds = new Set((question.answers || []).map((answer) => Number(answer.id)));
  return Array.from(
    new Set(
      (Array.isArray(selectedIds) ? selectedIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && validAnswerIds.has(value))
    )
  );
}

async function render(res, view, data = {}) {
  const viewData = {
    ...data,
    currentUser: res.locals.currentUser || null,
    isAdmin: Boolean(res.locals.isAdmin),
    prettyContent,
    renderRichContent,
  };
  const body = await renderFile(path.join(viewsDir, view), viewData);
  const html = await renderFile(path.join(viewsDir, 'layout.ejs'), {
    ...viewData,
    body,
  });
  res.status(200).send(html);
}

function redirect(res, location) {
  res.redirect(location);
}

function sendNotFound(res) {
  res.status(404).send('Not found');
}

function parseCookies(cookieHeader) {
  const cookies = {};
  const raw = String(cookieHeader || '');
  raw.split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index === -1) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) return;
    cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isSafeNextPath(value) {
  const target = String(value || '');
  return target.startsWith('/') && !target.startsWith('//');
}

function setSessionCookie(res, token) {
  const maxAgeSeconds = 60 * 60 * 24 * 30;
  res.setHeader(
    'Set-Cookie',
    `sid=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

function getCurrentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.sid;
  if (!token) return null;
  const session = getSessionByToken(token);
  return session ? session.user : null;
}

function requireAuth(req, res, next) {
  if (!res.locals.currentUser) {
    const nextPath = encodeURIComponent(req.originalUrl || '/');
    return redirect(res, `/login?next=${nextPath}`);
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!res.locals.currentUser || res.locals.currentUser.role !== 'admin') {
    return render(res, 'message.ejs', {
      title: 'Không có quyền',
      message: 'Chỉ admin mới được thực hiện thao tác này.',
      backUrl: '/',
    });
  }
  return next();
}

function canAccessAttempt(attempt, user) {
  if (!attempt || !user) return false;
  if (user.role === 'admin') return true;
  return attempt.user_id == null ? false : Number(attempt.user_id) === Number(user.id);
}

function normalizeResultFilter(value) {
  return String(value || '').trim().toLowerCase() === 'wrong' ? 'wrong' : 'all';
}

async function renderChangePasswordPage(res, overrides = {}) {
  await render(res, 'change-password.ejs', {
    title: 'Đổi mật khẩu',
    error: '',
    success: '',
    ...overrides,
  });
}

app.get('/login', async (req, res) => {
  if (res.locals.currentUser) {
    return redirect(res, '/');
  }

  await render(res, 'login.ejs', {
    title: 'Đăng nhập',
    nextUrl: isSafeNextPath(req.query.next) ? req.query.next : '/',
  });
});

app.post('/login', async (req, res) => {
  if (res.locals.currentUser) {
    return redirect(res, '/');
  }

  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const nextUrl = isSafeNextPath(req.body.next) ? req.body.next : '/';

  const user = authenticateUser(username, password);
  if (!user) {
    return render(res, 'login.ejs', {
      title: 'Đăng nhập',
      nextUrl,
      error: 'Tên đăng nhập hoặc mật khẩu không đúng.',
    });
  }

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  createSession(user.id, token, expiresAt);
  setSessionCookie(res, token);
  return redirect(res, nextUrl);
});

app.post('/logout', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.sid) {
    deleteSession(cookies.sid);
  }
  clearSessionCookie(res);
  return redirect(res, '/login');
});

app.use((req, res, next) => {
  if (res.locals.currentUser) return next();
  return redirect(res, `/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
});

app.get('/account/password', async (_req, res) => {
  await renderChangePasswordPage(res);
});

app.post('/account/password', async (req, res) => {
  const currentPassword = String(req.body.current_password || '');
  const newPassword = String(req.body.new_password || '');
  const confirmPassword = String(req.body.confirm_password || '');
  const currentUser = res.locals.currentUser;

  if (!currentPassword || !newPassword || !confirmPassword) {
    return renderChangePasswordPage(res, {
      error: 'Vui lòng nhập đầy đủ mật khẩu hiện tại, mật khẩu mới và xác nhận mật khẩu mới.',
    });
  }

  if (!authenticateUser(currentUser.username, currentPassword)) {
    return renderChangePasswordPage(res, {
      error: 'Mật khẩu hiện tại không đúng.',
    });
  }

  if (newPassword.length < 6) {
    return renderChangePasswordPage(res, {
      error: 'Mật khẩu mới phải có ít nhất 6 ký tự.',
    });
  }

  if (newPassword !== confirmPassword) {
    return renderChangePasswordPage(res, {
      error: 'Xác nhận mật khẩu mới chưa khớp.',
    });
  }

  if (newPassword === currentPassword) {
    return renderChangePasswordPage(res, {
      error: 'Mật khẩu mới cần khác mật khẩu hiện tại.',
    });
  }

  updateUserPassword(currentUser.id, newPassword);
  await renderChangePasswordPage(res, {
    success: 'Đổi mật khẩu thành công.',
  });
});

app.get('/', async (_req, res) => {
  await render(res, 'home.ejs', {
    title: 'Trang chủ',
    exams: listExams(),
  });
});

app.get('/exams/new', requireAdmin, async (_req, res) => {
  await render(res, 'exam-new.ejs', {
    title: 'Tạo bài thi',
  });
});

app.post('/exams', requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  if (!name) {
    return render(res, 'message.ejs', {
      title: 'Thiếu dữ liệu',
      message: 'Thiếu tên bài thi.',
      backUrl: '/exams/new',
    });
  }

  createExam(name, description);
  return redirect(res, '/');
});

app.post('/exams/:id/delete', requireAdmin, async (req, res) => {
  const exam = getExam(Number(req.params.id));
  if (!exam) return sendNotFound(res);

  deleteExam(exam.id);
  return redirect(res, '/');
});

app.post('/uploads/image', requireAdmin, async (req, res) => {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return res.status(400).json({ ok: false, message: 'Expected multipart/form-data' });
  }

  try {
    const { file } = await parseMultipartUpload(req);
    if (!file) {
      return res.status(400).json({ ok: false, message: 'No file uploaded' });
    }

    if (!isAllowedImageMime(file.mimeType)) {
      return res.status(400).json({ ok: false, message: 'Only image files are supported' });
    }

    const extension = extensionForMime(file.mimeType, file.filename);
    const safeName = `img-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`;
    const filePath = path.join(uploadsDir, safeName);
    writeFileSync(filePath, file.data);

    return res.json({
      ok: true,
      url: `/uploads/${safeName}`,
      filename: file.filename,
      markdown: createImageMarkdown(`/uploads/${safeName}`),
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Upload failed',
    });
  }
});

app.get('/exams/:id', async (req, res) => {
  const exam = getExam(Number(req.params.id));
  if (!exam) return sendNotFound(res);

  const allQuestions = listQuestionsForExam(exam.id).map(decorateQuestion);
  const pageSize = 10;
  const totalQuestions = allQuestions.length;
  const totalPages = Math.max(1, Math.ceil(totalQuestions / pageSize));
  const requestedPage = parsePositivePage(req.query.page);
  const currentPage = Math.min(requestedPage, totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedQuestions = allQuestions.slice(startIndex, startIndex + pageSize);

  await render(res, 'exam-detail.ejs', {
    title: exam.name,
    exam,
    questions: paginatedQuestions,
    pagination: {
      currentPage,
      pageSize,
      totalPages,
      totalQuestions,
      startIndex,
      endIndex: Math.min(startIndex + paginatedQuestions.length, totalQuestions),
      hasPrev: currentPage > 1,
      hasNext: currentPage < totalPages,
      prevPage: currentPage > 1 ? currentPage - 1 : 1,
      nextPage: currentPage < totalPages ? currentPage + 1 : totalPages,
    },
  });
});

app.get('/exams/:examId/questions/:questionId/edit', requireAdmin, async (req, res) => {
  const exam = getExam(Number(req.params.examId));
  const question = getQuestionForEdit(Number(req.params.questionId));
  if (!exam || !question || Number(question.exam_id) !== Number(exam.id)) {
    return sendNotFound(res);
  }

  await render(res, 'question-edit.ejs', {
    title: `Sửa câu hỏi - ${exam.name}`,
    exam,
    question: decorateQuestion(question),
    currentPage: parsePositivePage(req.query.page),
  });
});

app.post('/exams/:id/questions', requireAdmin, async (req, res) => {
  const exam = getExam(Number(req.params.id));
  if (!exam) return sendNotFound(res);
  const currentPage = parsePositivePage(req.body.page);
  const examPageUrl = `/exams/${exam.id}?page=${currentPage}`;

  const content = String(req.body.content || '').trim();
  const overallExplanation = String(req.body.overall_explanation || '').trim();
  const questionType = req.body.question_type === 'multi' ? 'multi' : 'single';
  const answers = normalizeAnswers(req.body);

  if (!content) {
    return render(res, 'message.ejs', {
      title: 'Thiếu dữ liệu',
      message: 'Thiếu nội dung câu hỏi.',
      backUrl: examPageUrl,
    });
  }

  if (answers.length < 2) {
    return render(res, 'message.ejs', {
      title: 'Thiếu đáp án',
      message: 'Cần ít nhất 2 đáp án.',
      backUrl: examPageUrl,
    });
  }

  if (hasDuplicateAnswers(answers)) {
    return render(res, 'message.ejs', {
      title: 'Đáp án trùng nhau',
      message: 'Các câu trả lời trong cùng một câu hỏi phải khác nhau.',
      backUrl: examPageUrl,
    });
  }

  const correctCount = answers.filter((item) => item.is_correct).length;
  if (questionType === 'single' && correctCount !== 1) {
    return render(res, 'message.ejs', {
      title: 'Lỗi đáp án đúng',
      message: 'Câu hỏi one choice phải có đúng 1 đáp án đúng.',
      backUrl: examPageUrl,
    });
  }

  if (questionType === 'multi' && correctCount < 2) {
    return render(res, 'message.ejs', {
      title: 'Lỗi đáp án đúng',
      message: 'Câu hỏi multi choice phải có ít nhất 2 đáp án đúng.',
      backUrl: examPageUrl,
    });
  }

  createQuestion(exam.id, content, overallExplanation, questionType, answers);
  return redirect(res, examPageUrl);
});

app.post('/exams/:examId/questions/:questionId', requireAdmin, async (req, res) => {
  const exam = getExam(Number(req.params.examId));
  const question = getQuestionForEdit(Number(req.params.questionId));
  if (!exam || !question || Number(question.exam_id) !== Number(exam.id)) {
    return sendNotFound(res);
  }
  const currentPage = parsePositivePage(req.body.page);
  const examPageUrl = `/exams/${exam.id}?page=${currentPage}`;
  const editPageUrl = `/exams/${exam.id}/questions/${question.id}/edit?page=${currentPage}`;

  const content = String(req.body.content || '').trim();
  const overallExplanation = String(req.body.overall_explanation || '').trim();
  const questionType = req.body.question_type === 'multi' ? 'multi' : 'single';
  const answers = normalizeAnswersWithIds(req.body);

  if (!content) {
    return render(res, 'message.ejs', {
      title: 'Thiếu dữ liệu',
      message: 'Thiếu nội dung câu hỏi.',
      backUrl: editPageUrl,
    });
  }

  if (answers.length < 2) {
    return render(res, 'message.ejs', {
      title: 'Thiếu đáp án',
      message: 'Cần ít nhất 2 đáp án.',
      backUrl: editPageUrl,
    });
  }

  if (hasDuplicateAnswers(answers)) {
    return render(res, 'message.ejs', {
      title: 'Đáp án trùng nhau',
      message: 'Các câu trả lời trong cùng một câu hỏi phải khác nhau.',
      backUrl: editPageUrl,
    });
  }

  const correctCount = answers.filter((item) => item.is_correct).length;
  if (questionType === 'single' && correctCount !== 1) {
    return render(res, 'message.ejs', {
      title: 'Lỗi đáp án đúng',
      message: 'Câu hỏi one choice phải có đúng 1 đáp án đúng.',
      backUrl: editPageUrl,
    });
  }

  if (questionType === 'multi' && correctCount < 2) {
    return render(res, 'message.ejs', {
      title: 'Lỗi đáp án đúng',
      message: 'Câu hỏi multi choice phải có ít nhất 2 đáp án đúng.',
      backUrl: editPageUrl,
    });
  }

  updateQuestion(question.id, exam.id, content, overallExplanation, questionType, answers);
  return redirect(res, examPageUrl);
});

app.post('/exams/:examId/questions/:questionId/delete', requireAdmin, async (req, res) => {
  const exam = getExam(Number(req.params.examId));
  const question = getQuestionForEdit(Number(req.params.questionId));
  if (!exam || !question || Number(question.exam_id) !== Number(exam.id)) {
    return sendNotFound(res);
  }
  const currentPage = parsePositivePage(req.body.page || req.query.page);

  deleteQuestion(question.id);
  return redirect(res, `/exams/${exam.id}?page=${currentPage}`);
});

app.get('/practice/new', async (_req, res) => {
  await render(res, 'practice-start.ejs', {
    title: 'Thi thử',
    exams: listExams(),
  });
});

app.post('/practice/start', async (req, res) => {
  const exam = getExam(Number(req.body.exam_id));
  if (!exam) return sendNotFound(res);

  const durationMinutes = Math.max(1, Math.min(600, Number.parseInt(req.body.duration_minutes, 10) || 15));
  const shuffleQuestions = req.body.shuffle_questions ? 1 : 0;
  const questions = listQuestionsForExam(exam.id);

  if (questions.length === 0) {
    return render(res, 'message.ejs', {
      title: 'Thiếu câu hỏi',
      message: 'Bài thi này chưa có câu hỏi nào.',
      backUrl: `/exams/${exam.id}`,
    });
  }

  const attempt = createAttempt(
    exam.id,
    `${exam.name} - ${new Date().toLocaleString('vi-VN')}`,
    durationMinutes,
    shuffleQuestions,
    res.locals.currentUser.id
  );
  return redirect(res, `/attempt/${attempt.id}`);
});

app.get('/attempts/history', requireAuth, async (req, res) => {
  const currentUser = res.locals.currentUser;
  const attempts = currentUser.role === 'admin'
    ? listAttemptHistory()
    : listAttemptHistory(currentUser.id);

  await render(res, 'attempt-history.ejs', {
    title: 'Lịch sử thi',
    attempts,
  });
});

app.get('/attempt/:id', async (req, res) => {
  const attempt = getAttemptWithExam(Number(req.params.id));
  if (!attempt) return sendNotFound(res);
  if (!canAccessAttempt(attempt, res.locals.currentUser)) {
    return render(res, 'message.ejs', {
      title: 'Không có quyền',
      message: 'Bạn chỉ có thể xem bài thi của mình.',
      backUrl: '/',
    });
  }

  if (isAttemptExpired(attempt)) {
    finalizeAttemptFromStoredAnswers(attempt.id, true);
    return redirect(res, `/attempt/${attempt.id}/result`);
  }

  if (attempt.submitted_at) {
    return redirect(res, `/attempt/${attempt.id}/result`);
  }

  const questions = loadAttemptQuestions(attempt);
  const answersMap = loadAttemptAnswersMap(attempt.id);
  const remainingSeconds = Math.max(0, Math.floor((Date.now() - new Date(String(attempt.started_at).replace(' ', 'T') + 'Z').getTime()) / 1000));
  const totalSeconds = attempt.duration_minutes * 60;

  await render(res, 'attempt.ejs', {
    title: `${attempt.exam_name} - Thi thử`,
    attempt,
    questions: questions.map(decorateQuestion),
    answersMap,
    timerSeconds: Math.max(0, totalSeconds - remainingSeconds),
  });
});

app.post('/attempt/:id/answer', async (req, res) => {
  const attempt = getAttempt(Number(req.params.id));
  if (!attempt) return sendNotFound(res);
  if (!canAccessAttempt(attempt, res.locals.currentUser)) {
    return res.status(403).json({ ok: false, message: 'forbidden' });
  }
  if (attempt.submitted_at) return res.json({ ok: false, submitted: true });
  if (isAttemptExpired(attempt)) {
    finalizeAttemptFromStoredAnswers(attempt.id, true);
    return res.json({ ok: false, submitted: true, expired: true });
  }

  const questionId = Number(req.body.questionId);
  const question = loadAttemptQuestions(attempt).find((item) => Number(item.id) === questionId);
  if (!question) {
    return res.status(400).json({ ok: false, message: 'invalid_question' });
  }

  const selectedAnswerIds = normalizeSelectedAnswerIdsForQuestion(question, parseSelectedIds(req.body.selectedAnswerIds));
  saveAttemptAnswer(attempt.id, questionId, selectedAnswerIds);
  return res.json({ ok: true });
});

app.post('/attempt/:id/submit', async (req, res) => {
  const attempt = getAttempt(Number(req.params.id));
  if (!attempt) return sendNotFound(res);
  if (!canAccessAttempt(attempt, res.locals.currentUser)) {
    return render(res, 'message.ejs', {
      title: 'Không có quyền',
      message: 'Bạn chỉ có thể nộp bài thi của mình.',
      backUrl: '/',
    });
  }
  if (attempt.submitted_at) return redirect(res, `/attempt/${attempt.id}/result`);

  const questions = loadAttemptQuestions(attempt);
  const existingAnswersMap = loadAttemptAnswersMap(attempt.id);
  const answersByQuestion = req.body && typeof req.body === 'object' ? req.body.answersByQuestion : null;
  for (const question of questions) {
    const key = String(question.id);
    const raw = answersByQuestion && Object.prototype.hasOwnProperty.call(answersByQuestion, key)
      ? answersByQuestion[key]
      : req.body[`q_${question.id}`];
    const selectedAnswerIds = raw === undefined
      ? normalizeSelectedAnswerIdsForQuestion(question, existingAnswersMap.get(question.id) || [])
      : normalizeSelectedAnswerIdsForQuestion(question, parseSelectedIds(raw));
    saveAttemptAnswer(attempt.id, question.id, selectedAnswerIds);
  }

  finalizeAttemptFromStoredAnswers(attempt.id, isAttemptExpired(attempt));
  return redirect(res, `/attempt/${attempt.id}/result`);
});

app.get('/attempt/:id/result', async (req, res) => {
  const attempt = getAttempt(Number(req.params.id));
  if (!attempt) return sendNotFound(res);
  if (!canAccessAttempt(attempt, res.locals.currentUser)) {
    return render(res, 'message.ejs', {
      title: 'Không có quyền',
      message: 'Bạn chỉ có thể xem kết quả bài thi của mình.',
      backUrl: '/',
    });
  }

  if (!attempt.submitted_at && isAttemptExpired(attempt)) {
    finalizeAttemptFromStoredAnswers(attempt.id, true);
  }

  const scored = getAttemptResult(attempt.id);
  if (!scored) return sendNotFound(res);

  await render(res, 'result.ejs', {
    title: 'Kết quả thi',
    attempt: decorateAttempt(scored),
    activeFilter: normalizeResultFilter(req.query.filter),
  });
});

app.get('/admin/users', requireAdmin, async (_req, res) => {
  await render(res, 'admin-users.ejs', {
    title: 'Quản lý người dùng',
    users: listUsers(),
  });
});

app.post('/admin/users', requireAdmin, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const displayName = String(req.body.display_name || '').trim();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'user';

  if (!username || !displayName || !password) {
    return render(res, 'message.ejs', {
      title: 'Thiếu dữ liệu',
      message: 'Cần username, tên hiển thị và mật khẩu.',
      backUrl: '/admin/users',
    });
  }

  try {
    createUser(username, displayName, password, role);
  } catch (error) {
    return render(res, 'message.ejs', {
      title: 'Không thể tạo user',
      message: 'Username có thể đã tồn tại.',
      backUrl: '/admin/users',
    });
  }

  return redirect(res, '/admin/users');
});

app.post('/admin/users/:id', requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const username = String(req.body.username || '').trim();
  const displayName = String(req.body.display_name || '').trim();
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  const password = String(req.body.password || '').trim();
  const targetUser = listUsers().find((user) => Number(user.id) === userId);
  const adminCount = listUsers().filter((user) => user.role === 'admin').length;

  if (!username || !displayName) {
    return render(res, 'message.ejs', {
      title: 'Thiếu dữ liệu',
      message: 'Username và tên hiển thị không được để trống.',
      backUrl: '/admin/users',
    });
  }

  if (Number(res.locals.currentUser.id) === userId && role !== 'admin') {
    return render(res, 'message.ejs', {
      title: 'Không hợp lệ',
      message: 'Bạn không thể tự hạ quyền admin của chính mình.',
      backUrl: '/admin/users',
    });
  }

  if (targetUser && targetUser.role === 'admin' && role !== 'admin' && adminCount <= 1) {
    return render(res, 'message.ejs', {
      title: 'Không hợp lệ',
      message: 'Phải giữ ít nhất một tài khoản admin trong hệ thống.',
      backUrl: '/admin/users',
    });
  }

  try {
    updateUser(userId, username, displayName, role, true);
    if (password) {
      updateUserPassword(userId, password);
    }
  } catch (error) {
    return render(res, 'message.ejs', {
      title: 'Không thể cập nhật user',
      message: 'Username có thể đã tồn tại.',
      backUrl: '/admin/users',
    });
  }

  return redirect(res, '/admin/users');
});

app.post('/admin/users/:id/delete', requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const targetUser = listUsers().find((user) => Number(user.id) === userId);
  const adminCount = listUsers().filter((user) => user.role === 'admin').length;
  if (Number(res.locals.currentUser.id) === userId) {
    return render(res, 'message.ejs', {
      title: 'Không hợp lệ',
      message: 'Bạn không thể xóa chính tài khoản đang đăng nhập.',
      backUrl: '/admin/users',
    });
  }

  if (targetUser && targetUser.role === 'admin' && adminCount <= 1) {
    return render(res, 'message.ejs', {
      title: 'Không hợp lệ',
      message: 'Phải giữ ít nhất một tài khoản admin trong hệ thống.',
      backUrl: '/admin/users',
    });
  }

  deleteSessionsByUserId(userId);
  deleteAttemptsByUserId(userId);
  deleteUser(userId);
  return redirect(res, '/admin/users');
});

setInterval(() => {
  autoSubmitExpiredAttempts();
}, 5000).unref();

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Quiz Simulator running at http://localhost:${port}`);
});
