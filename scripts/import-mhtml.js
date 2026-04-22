import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

process.env.SKIP_DEMO_SEED = process.env.SKIP_DEMO_SEED || '1';

const { createExam, createQuestion, listExams } = await import('../db.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.join(projectRoot, 'public', 'uploads'));
const defaultImportsDir = path.join(projectRoot, 'data-imports');

function parseArgs(argv) {
  const result = {
    file: '',
    exam: '',
    limit: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (arg === '--file' || arg === '-f') {
      result.file = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (arg === '--exam' || arg === '-e') {
      result.exam = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (arg === '--limit' || arg === '-l') {
      const value = Number.parseInt(String(argv[index + 1] || ''), 10);
      result.limit = Number.isInteger(value) && value > 0 ? value : null;
      index += 1;
    }
  }

  return result;
}

function printHelp() {
  output.write([
    'Usage: npm run import:mhtml -- [options]',
    '',
    'Options:',
    '  --file,  -f <path>   Path to .mhtml file',
    '  --exam,  -e <name>   Existing exam name or new exam name',
    '  --limit, -l <count>  Import only the first N questions',
    '  --help,  -h          Show this help',
    '',
    'If --file or --exam is omitted, the tool will prompt for it.',
    '',
  ].join('\n'));
}

function decodeQuotedPrintableToBuffer(value) {
  const normalized = String(value || '').replace(/=\r?\n/g, '');
  const bytes = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const hex = normalized.slice(index + 1, index + 3);
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    bytes.push(normalized.charCodeAt(index) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeTextPart(body, transferEncoding) {
  const encoding = String(transferEncoding || '').trim().toLowerCase();
  if (encoding === 'quoted-printable') {
    return decodeQuotedPrintableToBuffer(body).toString('utf8');
  }
  if (encoding === 'base64') {
    return Buffer.from(String(body || '').replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  return String(body || '');
}

function decodeBinaryPart(body, transferEncoding) {
  const encoding = String(transferEncoding || '').trim().toLowerCase();
  if (encoding === 'base64') {
    return Buffer.from(String(body || '').replace(/\s+/g, ''), 'base64');
  }
  if (encoding === 'quoted-printable') {
    return decodeQuotedPrintableToBuffer(body);
  }
  return Buffer.from(String(body || ''), 'utf8');
}

function parseHeaders(headerText) {
  const headers = new Map();
  let currentKey = '';
  for (const rawLine of String(headerText || '').split(/\r?\n/)) {
    if (!rawLine) continue;
    if (/^[ \t]/.test(rawLine) && currentKey) {
      headers.set(currentKey, `${headers.get(currentKey)} ${rawLine.trim()}`);
      continue;
    }
    const colonIndex = rawLine.indexOf(':');
    if (colonIndex === -1) continue;
    currentKey = rawLine.slice(0, colonIndex).trim().toLowerCase();
    headers.set(currentKey, rawLine.slice(colonIndex + 1).trim());
  }
  return headers;
}

function parseMhtml(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const boundaryMatch = raw.match(/boundary="([^"]+)"/i);
  if (!boundaryMatch) {
    throw new Error('Could not find MIME boundary in the MHTML file.');
  }

  const boundary = boundaryMatch[1];
  const pieces = raw.split(`--${boundary}`);
  let html = '';
  let subject = '';
  const subjectMatch = raw.match(/^Subject:\s*(.+)$/im);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
  }

  const resources = new Map();

  for (const piece of pieces) {
    const trimmed = piece.trim();
    if (!trimmed || trimmed === '--') continue;

    const separator = trimmed.search(/\r?\n\r?\n/);
    if (separator === -1) continue;

    const headerText = trimmed.slice(0, separator);
    const body = trimmed.slice(separator).replace(/^\r?\n\r?\n/, '');
    const headers = parseHeaders(headerText);
    const contentType = String(headers.get('content-type') || '').toLowerCase();
    const contentLocation = String(headers.get('content-location') || '').trim();
    const contentIdRaw = String(headers.get('content-id') || '').trim();
    const transferEncoding = String(headers.get('content-transfer-encoding') || '').trim();
    const contentId = contentIdRaw.replace(/^<|>$/g, '');

    if (!html && contentType.includes('text/html') && contentLocation.includes('/result/')) {
      html = decodeTextPart(body, transferEncoding);
    }

    if (contentType.startsWith('image/')) {
      const resource = {
        contentType,
        transferEncoding,
        body,
      };
      if (contentLocation) resources.set(contentLocation, resource);
      if (contentId) resources.set(`cid:${contentId}`, resource);
    }
  }

  if (!html) {
    throw new Error('Could not find the main HTML part in the MHTML file.');
  }

  return { html, resources, subject };
}

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    const lower = String(entity).toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === '#39' || lower === 'apos') return "'";
    if (lower === 'nbsp') return ' ';
    if (lower.startsWith('#x')) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (lower.startsWith('#')) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return match;
  });
}

function stripTags(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ''));
}

function collapseWhitespace(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

function extensionForMime(mimeType, sourceUrl = '') {
  const cleanUrl = String(sourceUrl || '').split('?')[0];
  const urlExtension = path.extname(cleanUrl).toLowerCase();
  if (urlExtension) return urlExtension;
  switch (String(mimeType || '').toLowerCase()) {
    case 'image/png': return '.png';
    case 'image/jpeg':
    case 'image/jpg': return '.jpg';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    case 'image/svg+xml': return '.svg';
    default: return '.bin';
  }
}

function saveImageResource(sourceUrl, resources, cache) {
  const normalizedUrl = decodeHtmlEntities(String(sourceUrl || '').trim());
  if (!normalizedUrl) return '';
  if (cache.has(normalizedUrl)) return cache.get(normalizedUrl);

  const resource = resources.get(normalizedUrl);
  if (!resource) return normalizedUrl;

  if (!existsSync(uploadsDir)) {
    mkdirSync(uploadsDir, { recursive: true });
  }

  const extension = extensionForMime(resource.contentType, normalizedUrl);
  const fileName = `import-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${extension}`;
  writeFileSync(path.join(uploadsDir, fileName), decodeBinaryPart(resource.body, resource.transferEncoding));

  const localUrl = `/uploads/${fileName}`;
  cache.set(normalizedUrl, localUrl);
  return localUrl;
}

function htmlSnippetToContent(html, resources, imageCache) {
  let text = String(html || '');
  const emittedImages = new Set();

  text = text.replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, '');
  text = text.replace(/<img\b([^>]*?)src="([^"]+)"([^>]*?)>/gi, (_match, before, src) => {
    if (/display\s*:\s*none/i.test(before)) {
      return '';
    }
    const finalUrl = saveImageResource(src, resources, imageCache);
    if (!finalUrl || emittedImages.has(finalUrl)) {
      return '';
    }
    emittedImages.add(finalUrl);
    return `\n\n![image](${finalUrl})\n\n`;
  });

  text = text.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href, inner) => {
    const label = collapseWhitespace(stripTags(inner));
    const target = decodeHtmlEntities(href).trim();
    if (!label) return target;
    return label === target ? label : `${label} (${target})`;
  });

  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|section|article|h1|h2|h3|h4|h5|h6|ul|ol|table|tr)\s*>/gi, '\n');
  text = text.replace(/<li\b[^>]*>/gi, '- ');
  text = text.replace(/<\/li\s*>/gi, '\n');
  text = text.replace(/<p\b[^>]*>/gi, '');
  text = text.replace(/<div\b[^>]*>/gi, '');
  text = text.replace(/<span\b[^>]*>/gi, '');
  text = text.replace(/<\/(span|strong|em|code|b|i|u)\s*>/gi, '');
  text = text.replace(/<(strong|em|code|b|i|u)\b[^>]*>/gi, '');
  text = text.replace(/<[^>]+>/g, '');

  return collapseWhitespace(decodeHtmlEntities(text));
}

function splitBlocksByMarker(source, marker) {
  const results = [];
  let startIndex = source.indexOf(marker);
  while (startIndex !== -1) {
    const nextIndex = source.indexOf(marker, startIndex + marker.length);
    results.push(source.slice(startIndex, nextIndex === -1 ? source.length : nextIndex));
    startIndex = nextIndex;
  }
  return results;
}

function extractSection(source, startMarker, endMarkers) {
  const startIndex = source.indexOf(startMarker);
  if (startIndex === -1) return '';
  const openTagEnd = source.indexOf('>', startIndex);
  if (openTagEnd === -1) return '';

  const contentStart = openTagEnd + 1;
  let contentEnd = -1;
  for (const marker of endMarkers) {
    const index = source.indexOf(marker, contentStart);
    if (index !== -1 && (contentEnd === -1 || index < contentEnd)) {
      contentEnd = index;
    }
  }
  return contentEnd === -1 ? source.slice(contentStart) : source.slice(contentStart, contentEnd);
}

function parseQuestionsFromHtml(html, resources, limit = null) {
  const questionBlocks = splitBlocksByMarker(html, '<div class="result-pane--question-result-pane-wrapper');
  const imageCache = new Map();
  const questions = [];

  for (const block of questionBlocks) {
    const numberMatch = block.match(/Question\s+(\d+)/i);
    const questionNumber = numberMatch ? Number.parseInt(numberMatch[1], 10) : questions.length + 1;
    const promptHtml = extractSection(
      block,
      'id="question-prompt"',
      ['<div class="result-pane--question-result-pane-expanded-content']
    );
    const answersHtml = extractSection(
      block,
      '<div class="result-pane--question-result-pane-expanded-content',
      ['<div class="result-pane--question-related-fields']
    );
    const explanationHtml = extractSection(
      block,
      'id="overall-explanation"',
      ['</div></div><div data-purpose="domain-pane"', '</div></div></div></div><div class="result-pane--question-result-pane-wrapper', '</body>']
    );

    const answerBlocks = splitBlocksByMarker(answersHtml, '<div class="result-pane--answer-result-pane');
    const answers = answerBlocks
      .map((answerBlock) => ({
        content: htmlSnippetToContent(
          extractSection(answerBlock, 'id="answer-text"', ['</div></div></div>', '</div></div><div']),
          resources,
          imageCache
        ),
        is_correct: answerBlock.includes('answer-result-pane--answer-correct') || answerBlock.includes('>Correct answer<'),
      }))
      .filter((answer) => answer.content);

    const correctCount = answers.filter((answer) => answer.is_correct).length;
    if (!promptHtml || answers.length < 2 || correctCount === 0) {
      continue;
    }

    questions.push({
      source_number: questionNumber,
      content: htmlSnippetToContent(promptHtml, resources, imageCache),
      overall_explanation: htmlSnippetToContent(explanationHtml, resources, imageCache),
      question_type: correctCount > 1 ? 'multi' : 'single',
      answers,
    });

    if (limit && questions.length >= limit) {
      break;
    }
  }

  return questions;
}

function findExactExam(exams, value) {
  const normalized = String(value || '').trim().toLowerCase();
  return exams.find((exam) => String(exam.name || '').trim().toLowerCase() === normalized) || null;
}

function createExamRecord(name, description) {
  const result = createExam(name, description);
  return Number(result.lastInsertRowid);
}

async function promptForFile(cliFile, rl) {
  if (cliFile) {
    const resolved = path.resolve(cliFile);
    if (!existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }
    return resolved;
  }

  const defaultFile = path.join(defaultImportsDir, 'Practice Test 3.mhtml');
  const hint = existsSync(defaultFile) ? ` [default: ${defaultFile}]` : '';
  const answer = (await rl.question(`MHTML file path${hint}: `)).trim();
  const chosen = answer || defaultFile;
  const resolved = path.resolve(chosen);
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  return resolved;
}

async function promptForExam(cliExam, fallbackName, rl) {
  const exams = listExams();
  if (cliExam) {
    const existing = findExactExam(exams, cliExam);
    if (existing) {
      return { id: Number(existing.id), name: existing.name, created: false };
    }
    const examId = createExamRecord(cliExam, 'Imported from MHTML');
    return { id: examId, name: cliExam, created: true };
  }

  if (exams.length) {
    output.write('Existing exams:\n');
    exams.forEach((exam, index) => {
      output.write(`  ${index + 1}. ${exam.name}\n`);
    });
  } else {
    output.write('No exams found. A new exam will be created.\n');
  }

  const defaultLabel = fallbackName ? ` [default: ${fallbackName}]` : '';
  const answer = (await rl.question(`Choose exam number or type a new exam name${defaultLabel}: `)).trim();
  const rawValue = answer || fallbackName;
  if (!rawValue) {
    throw new Error('Exam name is required.');
  }

  const asNumber = Number.parseInt(rawValue, 10);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= exams.length) {
    const exam = exams[asNumber - 1];
    return { id: Number(exam.id), name: exam.name, created: false };
  }

  const existing = findExactExam(exams, rawValue);
  if (existing) {
    return { id: Number(existing.id), name: existing.name, created: false };
  }

  const examId = createExamRecord(rawValue, 'Imported from MHTML');
  return { id: examId, name: rawValue, created: true };
}

function sanitizeFallbackExamName(subject, filePath) {
  const subjectText = String(subject || '').trim();
  if (subjectText) return subjectText;
  return path.basename(filePath, path.extname(filePath));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const rl = createInterface({ input, output });
  try {
    const filePath = await promptForFile(args.file, rl);
    const { html, resources, subject } = parseMhtml(filePath);
    const fallbackExamName = sanitizeFallbackExamName(subject, filePath);
    const exam = await promptForExam(args.exam, fallbackExamName, rl);
    const questions = parseQuestionsFromHtml(html, resources, args.limit);

    if (!questions.length) {
      throw new Error('No questions could be parsed from the selected MHTML file.');
    }

    for (const question of questions) {
      createQuestion(exam.id, question.content, question.overall_explanation, question.question_type, question.answers);
    }

    output.write('\n');
    output.write(`Imported ${questions.length} question(s) into exam "${exam.name}".\n`);
    output.write(`Images were copied to ${uploadsDir}.\n`);
    if (exam.created) {
      output.write('A new exam was created for this import.\n');
    } else {
      output.write('Questions were appended to the existing exam.\n');
    }
    if (args.limit) {
      output.write(`Limit used: first ${args.limit} question(s).\n`);
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  output.write(`\nImport failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
