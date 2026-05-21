import crypto from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import cors from 'cors';
import express from 'express';
import { XMLParser } from 'fast-xml-parser';
import multer from 'multer';
import XLSX from 'xlsx';

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});
const PORT = process.env.PORT || 4000;
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5173';
const API_URL = process.env.API_URL || `http://127.0.0.1:${PORT}`;
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_COOKIE = 'dexor_session';
const CONCURRENCY = 5;
const CREDIT_COST = { quick: 1, deep: 3 };
const CREDIT_PACKAGES = [
  { id: 'credits_20', name: '20 크레딧', credits: 20, amount: 19900 },
  { id: 'credits_60', name: '60 크레딧', credits: 60, amount: 49900 },
  { id: 'credits_150', name: '150 크레딧', credits: 150, amount: 99000 },
];
const INDUSTRY_KEYWORDS = {
  food: ['맛집', '식당', '카페', '메뉴', '예약', '방문', '후기', '점심', '저녁', '디저트'],
  beauty: ['뷰티', '피부', '화장품', '관리', '시술', '헤어', '네일', '메이크업', '후기'],
  travel: ['여행', '숙소', '호텔', '코스', '가볼만한곳', '예약', '일정', '방문', '후기'],
  living: ['리빙', '인테리어', '살림', '가구', '주방', '생활', '정리', '후기'],
  parenting: ['육아', '아이', '아기', '키즈', '교육', '놀이', '엄마', '가족', '후기'],
  it: ['IT', '앱', '서비스', '기기', '노트북', '모바일', '설치', '리뷰', '사용기'],
  fashion: ['패션', '코디', '의류', '신발', '가방', '스타일', '착용', '후기'],
  pet: ['반려동물', '강아지', '고양이', '펫', '간식', '용품', '동물병원', '후기'],
};
const INDUSTRY_LABELS = {
  food: '맛집',
  beauty: '뷰티',
  travel: '여행',
  living: '리빙',
  parenting: '육아',
  it: 'IT',
  fashion: '패션',
  pet: '반려동물',
};
const INDUSTRY_ALIASES = {
  food: ['맛집', '음식', '식당', '카페', '푸드', '요리', '디저트'],
  beauty: ['뷰티', '미용', '피부', '화장품', '헤어', '네일', '에스테틱'],
  travel: ['여행', '숙소', '호텔', '관광', '캠핑', '나들이'],
  living: ['생활', '리빙', '인테리어', '살림', '가구', '주방'],
  parenting: ['육아', '아이', '아기', '키즈', '맘', '엄마', '교육'],
  it: ['IT', '앱', '서비스', '기기', '모바일', '노트북', '테크'],
  fashion: ['패션', '의류', '옷', '신발', '가방', '스타일'],
  pet: ['반려동물', '강아지', '고양이', '펫'],
};
const KEYWORD_STOPWORDS = new Set([
  '그리고', '하지만', '있는', '없는', '해서', '하는', '하면', '이번', '오늘', '내일', '정말', '너무', '같은',
  '블로그', '네이버', '후기', '리뷰', '추천', '방문', '사용', '직접', '콘텐츠', '포스팅', '좋은', '많이',
]);
const DAILY_VISITOR_MINIMUMS = {
  s: 500,
  a: 200,
  b: 80,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, '..');
const distDir = join(appRoot, 'dist');
const dataDir = process.env.DEXOR_DATA_DIR || join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'dexor.sqlite'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

function allowedOrigins(appUrl) {
  const origins = new Set([
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ]);
  const configured = String(appUrl || '').trim().replace(/\/$/, '');
  if (configured) {
    origins.add(configured);
    if (!/^https?:\/\//i.test(configured)) {
      origins.add(`https://${configured}`);
      origins.add(`http://${configured}`);
    }
  }
  return origins;
}

const corsOrigins = allowedOrigins(APP_URL);
app.use(cors({
  origin(origin, callback) {
    if (!origin || corsOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

const queue = [];
let activeWorkers = 0;

initDb();

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      avatar_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_accounts (
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider, provider_user_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_credits (
      user_id TEXT PRIMARY KEY,
      remaining INTEGER NOT NULL DEFAULT 0,
      used INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      ref_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      package_id TEXT NOT NULL,
      order_id TEXT UNIQUE NOT NULL,
      provider TEXT NOT NULL,
      amount INTEGER NOT NULL,
      credits INTEGER NOT NULL,
      status TEXT NOT NULL,
      payment_key TEXT,
      secret TEXT,
      virtual_account_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS analysis_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      total INTEGER NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      credit_cost INTEGER NOT NULL,
      credit_refunded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS blog_results (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      mode TEXT NOT NULL,
      score INTEGER NOT NULL,
      grade TEXT NOT NULL,
      decision TEXT NOT NULL,
      ad_ratio INTEGER NOT NULL,
      recent_activity TEXT NOT NULL,
      category TEXT NOT NULL,
      risk_flags TEXT NOT NULL,
      reasons TEXT NOT NULL,
      breakdown TEXT NOT NULL,
      recent_posts TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES analysis_jobs(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
}

function nowIso() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf('=');
        return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))];
      }),
  );
}

function getSessionUser(req) {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (!sessionId) return null;
  const row = db.prepare(`
    SELECT users.*
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ? AND sessions.expires_at > ?
  `).get(sessionId, nowIso());
  return row || null;
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ message: '로그인이 필요합니다.' });
  req.user = user;
  next();
}

function handleUpload(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: '업로드 파일은 5MB 이하만 지원합니다.' });
    return res.status(400).json({ message: '업로드 파일을 처리하지 못했습니다.' });
  });
}

function setSession(res, userId) {
  const sessionId = id('sess');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, userId, expiresAt, nowIso());
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 14,
  });
}

function clearSession(req, res) {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (sessionId) db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  res.clearCookie(SESSION_COOKIE);
}

function upsertOAuthUser({ provider, providerUserId, email, name, avatarUrl }) {
  const existingAccount = db.prepare('SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?')
    .get(provider, providerUserId);
  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  const userId = existingAccount?.user_id || existingUser?.id || id('user');
  const timestamp = nowIso();

  if (existingUser || existingAccount) {
    db.prepare('UPDATE users SET name = ?, avatar_url = COALESCE(?, avatar_url), updated_at = ? WHERE id = ?')
      .run(name, avatarUrl || null, timestamp, userId);
  } else {
    db.prepare('INSERT INTO users (id, email, name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, email, name, avatarUrl || null, timestamp, timestamp);
    db.prepare('INSERT INTO usage_credits (user_id, remaining, used, updated_at) VALUES (?, 20, 0, ?)')
      .run(userId, timestamp);
    db.prepare('INSERT INTO credit_ledger (id, user_id, amount, reason, ref_id, created_at) VALUES (?, ?, 20, ?, ?, ?)')
      .run(id('ledger'), userId, 'welcome', null, timestamp);
  }

  db.prepare(`
    INSERT INTO oauth_accounts (provider, provider_user_id, user_id, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(provider, provider_user_id) DO UPDATE SET user_id = excluded.user_id
  `).run(provider, providerUserId, userId, timestamp);

  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function getCredits(userId) {
  return db.prepare('SELECT user_id as userId, remaining, used FROM usage_credits WHERE user_id = ?').get(userId)
    || { userId, remaining: 0, used: 0 };
}

function addCredits(userId, amount, reason, refId = null) {
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO usage_credits (user_id, remaining, used, updated_at)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      remaining = remaining + excluded.remaining,
      updated_at = excluded.updated_at
  `).run(userId, amount, timestamp);
  db.prepare('INSERT INTO credit_ledger (id, user_id, amount, reason, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id('ledger'), userId, amount, reason, refId, timestamp);
}

function spendCredits(userId, amount, reason, refId) {
  const credits = getCredits(userId);
  if (credits.remaining < amount) return false;
  const timestamp = nowIso();
  db.prepare('UPDATE usage_credits SET remaining = remaining - ?, used = used + ?, updated_at = ? WHERE user_id = ?')
    .run(amount, amount, timestamp, userId);
  db.prepare('INSERT INTO credit_ledger (id, user_id, amount, reason, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id('ledger'), userId, -amount, reason, refId, timestamp);
  return true;
}

function parseBlogUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  let match = trimmed.match(/[?&]blogId=([a-zA-Z0-9._-]+).*?[?&]logNo=([0-9]+)/i)
    || trimmed.match(/[?&]logNo=([0-9]+).*?[?&]blogId=([a-zA-Z0-9._-]+)/i);
  if (match && /blogId=/i.test(match[0]) && /logNo=/i.test(match[0])) {
    return /[?&]blogId=/i.test(match[0])
      ? { blogId: match[1], logNo: match[2] }
      : { blogId: match[2], logNo: match[1] };
  }
  match = trimmed.match(/(?:https?:\/\/)?(?:m\.)?blog\.naver\.com\/([a-zA-Z0-9._-]+)(?:\/([0-9]+))?/i);
  if (match) return { blogId: match[1], logNo: match[2] || null };
  return null;
}

function normalizeBlogUrl(raw) {
  const parsed = parseBlogUrl(raw);
  if (!parsed) return null;
  return parsed.logNo
    ? `https://blog.naver.com/${parsed.blogId}/${parsed.logNo}`
    : `https://blog.naver.com/${parsed.blogId}`;
}

function getBlogId(url) {
  return parseBlogUrl(normalizeBlogUrl(url) || url)?.blogId || null;
}

function getLogNo(url) {
  return parseBlogUrl(normalizeBlogUrl(url) || url)?.logNo || null;
}

function extractUrlsFromText(text = '') {
  const matches = text.match(/(?:https?:\/\/)?(?:m\.)?blog\.naver\.com\/[^\s"'<>),]+/gi) || [];
  return [...new Set(matches.map(normalizeBlogUrl).filter(Boolean))];
}

function parseDailyVisitorValue(value) {
  const text = String(value ?? '').replace(/[,명\s]/g, '');
  const match = text.match(/\d+/);
  if (!match) return null;
  const number = Number.parseInt(match[0], 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function mergeDailyVisitor(map, url, value) {
  const normalizedUrl = normalizeBlogUrl(url);
  const dailyVisitors = parseDailyVisitorValue(value);
  if (!normalizedUrl || !dailyVisitors) return;
  map[normalizedUrl] = dailyVisitors;
  const blogId = getBlogId(normalizedUrl);
  if (blogId) map[blogId] = dailyVisitors;
}

function extractRowsFromText(text = '') {
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      if (line.includes('\t')) return line.split('\t').map((cell) => cell.trim());
      const cells = [];
      let current = '';
      let quoted = false;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '"') {
          quoted = !quoted;
        } else if (char === ',' && !quoted && !(/\d/.test(line[index - 1] || '') && /\d/.test(line[index + 1] || ''))) {
          cells.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      cells.push(current.trim());
      return cells;
    })
    .filter((row) => row.some(Boolean));
}

function extractDailyVisitorsFromRows(rows) {
  const map = {};
  let visitorColumn = -1;
  rows.forEach((row) => {
    const nextVisitorColumn = row.findIndex((cell) => /일\s*방문|방문자|visitor|daily/i.test(cell));
    if (nextVisitorColumn >= 0) visitorColumn = nextVisitorColumn;
    const urlCellIndex = row.findIndex((cell) => normalizeBlogUrl(cell));
    if (urlCellIndex < 0) return;
    const valueCell = visitorColumn >= 0 && visitorColumn !== urlCellIndex
      ? row[visitorColumn]
      : row.find((cell, index) => index !== urlCellIndex && parseDailyVisitorValue(cell));
    mergeDailyVisitor(map, row[urlCellIndex], valueCell);
  });
  return map;
}

function mergeMaps(...maps) {
  return Object.assign({}, ...maps.filter(Boolean));
}

function normalizeHeader(value = '') {
  return String(value).replace(/^\uFEFF/, '').replace(/[\s_-]+/g, '').toLowerCase();
}

function inferIndustry(value = '') {
  const text = String(value || '').trim();
  if (!text || /미입력|없음|unknown|n\/a/i.test(text)) return null;
  const compact = text.replace(/\s+/g, '').toLowerCase();
  return Object.entries(INDUSTRY_ALIASES).find(([, aliases]) => (
    aliases.some((alias) => compact.includes(String(alias).replace(/\s+/g, '').toLowerCase()))
  ))?.[0] || null;
}

function findHeaderRow(rows) {
  return rows.findIndex((row) => row.some((cell) => {
    const header = normalizeHeader(cell);
    return header.includes('url') || header.includes('카테고리') || header.includes('업종');
  }));
}

function extractCategoryOverridesFromRows(rows) {
  const map = {};
  const headerRowIndex = findHeaderRow(rows);
  const headers = headerRowIndex >= 0 ? rows[headerRowIndex].map(normalizeHeader) : [];
  const categoryColumns = headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => (
      header.includes('targetcategory')
      || header.includes('candidatecategory')
      || header.includes('후보카테고리')
      || header.includes('카테고리')
      || header.includes('업종')
      || header.includes('분야')
    ))
    .map(({ index }) => index);

  rows.slice(headerRowIndex >= 0 ? headerRowIndex + 1 : 0).forEach((row) => {
    const normalizedUrls = row.flatMap((cell) => extractUrlsFromText(cell));
    if (normalizedUrls.length === 0) return;

    const categoryValues = categoryColumns.length
      ? categoryColumns.map((index) => row[index])
      : row;
    const industry = categoryValues.map(inferIndustry).find(Boolean);
    if (!industry) return;

    normalizedUrls.forEach((url) => {
      map[url] = industry;
      const blogId = getBlogId(url);
      if (blogId) map[blogId] = industry;
    });
  });
  return map;
}

function normalizeCategoryOverrides(input = {}) {
  if (!input || typeof input !== 'object') return {};
  const map = {};
  Object.entries(input).forEach(([key, value]) => {
    const industry = INDUSTRY_LABELS[value] ? value : inferIndustry(value);
    if (!industry) return;
    const normalizedUrl = normalizeBlogUrl(key);
    if (normalizedUrl) {
      map[normalizedUrl] = industry;
      const blogId = getBlogId(normalizedUrl);
      if (blogId) map[blogId] = industry;
    } else {
      map[String(key).trim()] = industry;
    }
  });
  return map;
}

function extractRowsFromWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  return workbook.SheetNames.flatMap((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      blankrows: false,
      defval: '',
      raw: false,
    });
  })
    .map((row) => row.map((cell) => String(cell ?? '').trim()))
    .filter((row) => row.some(Boolean));
}

function extractUrlsFromUpload(file) {
  const name = file.originalname || '';
  if (/\.csv$/i.test(name) || file.mimetype === 'text/csv') {
    return extractUrlsFromText(file.buffer.toString('utf8'));
  }
  return [...new Set(extractRowsFromWorkbook(file.buffer).flatMap((row) => extractUrlsFromText(row.join(' '))))];
}

async function extractUploadSignals(file) {
  if (!file) return { urls: [], dailyVisitors: {} };
  const name = file.originalname || '';
  const rows = /\.csv$/i.test(name) || file.mimetype === 'text/csv'
    ? extractRowsFromText(file.buffer.toString('utf8'))
    : extractRowsFromWorkbook(file.buffer);
  return {
    urls: [...new Set(rows.flatMap((row) => extractUrlsFromText(row.join(' '))))],
    dailyVisitors: extractDailyVisitorsFromRows(rows),
    categoryOverrides: extractCategoryOverridesFromRows(rows),
  };
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function hash(input) {
  return [...input].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) % 9973, 7);
}

function gradeFromScore(score) {
  if (score >= 90) return 'S';
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

function decisionFromGrade(grade) {
  if (grade === 'S') return '바로 섭외 추천';
  if (grade === 'A') return '섭외 가능';
  if (grade === 'B') return '조건부 섭외';
  if (grade === 'C') return '우선순위 낮음';
  return '섭외 비추천';
}

function compareGrades(a, b) {
  const order = { S: 5, A: 4, B: 3, C: 2, D: 1 };
  return (order[a] || 0) - (order[b] || 0);
}

function minGrade(...grades) {
  return grades.filter(Boolean).sort(compareGrades)[0] || 'D';
}

function normalizeCampaign(input = {}) {
  const industry = INDUSTRY_LABELS[input.industry] ? input.industry : 'food';
  const rawKeyword = String(input.keyword || '').trim();
  const keyword = (rawKeyword || INDUSTRY_LABELS[industry]).slice(0, 40) || INDUSTRY_LABELS[industry];
  return { industry, industryLabel: INDUSTRY_LABELS[industry], keyword, keywordProvided: rawKeyword.length > 0 };
}

function normalizeDailyVisitorOverrides(input = {}) {
  if (!input || typeof input !== 'object') return {};
  const map = {};
  Object.entries(input).forEach(([key, value]) => {
    const dailyVisitors = parseDailyVisitorValue(value);
    if (!dailyVisitors) return;
    const normalizedUrl = normalizeBlogUrl(key);
    if (normalizedUrl) {
      map[normalizedUrl] = dailyVisitors;
      const blogId = getBlogId(normalizedUrl);
      if (blogId) map[blogId] = dailyVisitors;
    } else {
      map[String(key).trim()] = dailyVisitors;
    }
  });
  return map;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function weightedTopicScore(text, words) {
  const source = String(text || '').toLowerCase();
  return words.reduce((sum, word) => sum + (source.includes(String(word).toLowerCase()) ? 1 : 0), 0);
}

function textIncludesAnyTerm(text, terms) {
  const source = String(text || '').toLowerCase();
  return terms.some((term) => {
    const value = String(term || '').trim().toLowerCase();
    return value.length >= 2 && source.includes(value);
  });
}

function keywordSearchTerms(campaign) {
  const keyword = String(campaign.keyword || '').trim();
  const keywordParts = keyword.split(/[\s,/·|]+/).filter((word) => word.length >= 2);
  const defaultIndustryKeyword = !campaign.keywordProvided || keyword === INDUSTRY_LABELS[campaign.industry];
  const industryWords = defaultIndustryKeyword ? (INDUSTRY_KEYWORDS[campaign.industry] || []) : [];
  return [...new Set([keyword, ...keywordParts, ...industryWords].filter((word) => String(word).trim().length >= 2))];
}

function extractCandidateKeywords(posts, campaign, limit = 2) {
  const campaignTerms = new Set(keywordTerms(campaign).map((word) => String(word).toLowerCase()));
  const counts = new Map();
  posts.forEach((post, index) => {
    const weight = Math.max(1, 6 - index);
    const tokens = String(`${post.title || ''} ${post.description || ''}`)
      .match(/[가-힣A-Za-z0-9]{2,}/g) || [];
    tokens.forEach((token) => {
      const normalized = token.toLowerCase();
      if (KEYWORD_STOPWORDS.has(normalized) || campaignTerms.has(normalized)) return;
      if (/^\d+$/.test(normalized)) return;
      counts.set(normalized, (counts.get(normalized) || 0) + weight);
    });
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'))
    .slice(0, limit)
    .map(([keyword, weight]) => ({ keyword, weight }));
}

function estimateDailyVisitorSignal(posts, seed) {
  if (!posts.length) return null;
  const engagementAverage = posts.reduce((sum, post) => sum + post.comments * 3 + post.likes, 0) / posts.length;
  const recencyBoost = posts.filter((post) => post.daysAgo <= 7).length * 25;
  const estimatedAverage = Math.round(clamp(engagementAverage * 8 + recencyBoost + (seed % 90), 20, 900));
  const estimatedMin = Math.max(10, Math.round(estimatedAverage * 0.55));
  const estimatedMax = Math.round(estimatedAverage * 1.45);
  return {
    status: 'estimated',
    label: '공개 반응 기반 추정',
    estimatedAverage,
    estimatedMin,
    estimatedMax,
    minimums: DAILY_VISITOR_MINIMUMS,
  };
}

function htmlDecode(input = '') {
  return String(input)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)));
}

function extractMetaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(html).match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'))
    || String(html).match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i'));
  return htmlDecode(match?.[1] || '');
}

function extractReadablePostText(html) {
  const source = String(html || '');
  const start = source.indexOf('se-main-container');
  const end = source.indexOf('post_footer_contents', start);
  const contentHtml = start >= 0 ? source.slice(start, end > start ? end : start + 120000) : source;
  return stripHtml(htmlDecode(contentHtml));
}

function keywordTerms(campaign) {
  const industryWords = INDUSTRY_KEYWORDS[campaign.industry] || [];
  const keywordParts = String(campaign.keyword || '').split(/[\s,/·|]+/).filter((word) => word.length >= 2);
  return [...new Set([...industryWords, campaign.keyword, ...keywordParts].filter(Boolean))];
}

async function collectPostSignals(url, campaign) {
  const blogId = getBlogId(url);
  const logNo = getLogNo(url);
  if (!blogId || !logNo) return null;

  const encodedBlogId = encodeURIComponent(blogId);
  const encodedLogNo = encodeURIComponent(logNo);
  const postUrls = [
    `https://blog.naver.com/PostView.naver?blogId=${encodedBlogId}&logNo=${encodedLogNo}`,
    `https://m.blog.naver.com/PostView.naver?blogId=${encodedBlogId}&logNo=${encodedLogNo}`,
    `https://blog.naver.com/${encodedBlogId}/${encodedLogNo}`,
  ];
  let html = '';
  let lastError = null;
  for (const postUrl of postUrls) {
    try {
      const response = await fetch(postUrl, {
        signal: AbortSignal.timeout(7000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      if (!response.ok) throw new Error(`네이버 포스트 접근 실패 (${response.status})`);
      const nextHtml = await response.text();
      if (nextHtml && nextHtml.length > html.length) html = nextHtml;
      if (nextHtml.includes('se-main-container') || extractMetaContent(nextHtml, 'og:title')) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!html) throw lastError || new Error('개별 포스트 본문을 읽지 못했습니다.');
  const title = extractMetaContent(html, 'og:title') || stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const description = extractMetaContent(html, 'og:description');
  const body = extractReadablePostText(html);
  const combined = `${title} ${description} ${body}`;
  if (stripHtml(combined).length < 80) throw new Error('개별 포스트 본문을 충분히 읽지 못했습니다.');

  const dateMatch = html.match(/\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.\s*\d{1,2}:\d{2}/);
  const terms = keywordTerms(campaign);
  const exactKeyword = String(campaign.keyword || '').trim();
  const titleHits = weightedTopicScore(title, terms);
  const bodyHits = weightedTopicScore(`${description} ${body}`, terms);
  const exactBonus = exactKeyword && combined.toLowerCase().includes(exactKeyword.toLowerCase()) ? 18 : 0;
  const titleBonus = exactKeyword && title.toLowerCase().includes(exactKeyword.toLowerCase()) ? 18 : 0;
  const topicFit = Math.round(clamp(titleHits * 11 + bodyHits * 8 + exactBonus + titleBonus));
  const experienceFit = ['방문', '사용', '먹어', '다녀', '직접', '후기', '느꼈', '추천', '메뉴', '가격', '위치']
    .filter((word) => combined.includes(word)).length;
  const experienceScore = Math.round(clamp(experienceFit * 12));
  const imageCount = (html.match(/se-image-resource|blogthumb|postfiles\.pstatic/g) || []).length;
  const bodyLength = stripHtml(body).length;
  const qualityFit = Math.round(clamp((bodyLength / 18) + Math.min(imageCount, 12) * 4));
  const adSignals = ['제공', '협찬', '광고', '체험단', '원고료', '소정의'].filter((word) => combined.includes(word));
  const adPenalty = adSignals.length >= 3 ? 12 : adSignals.length >= 1 ? 5 : 0;
  const postFit = Math.round(clamp(topicFit * 0.48 + experienceScore * 0.24 + qualityFit * 0.28 - adPenalty));

  return {
    sourceStatus: 'post-view',
    blogId,
    logNo,
    title: title.replace(/\s*:\s*네이버\s*블로그\s*$/i, '').trim(),
    description,
    publishedAtLabel: dateMatch?.[0] || null,
    bodyLength,
    imageCount,
    topicFit,
    experienceFit: experienceScore,
    qualityFit,
    adSignals,
    postFit,
  };
}

function normalizeLegacyIndex(value = '') {
  const text = String(value).trim();
  if (!text) return null;
  if (/초급|준최\s*1|준최\s*2|low|beginner/i.test(text)) return '초급';
  if (/중급|준최\s*3|준최\s*4|mid|middle/i.test(text)) return '중급';
  if (/고급|최적|준최\s*5|high|advanced/i.test(text)) return '고급';
  return text.slice(0, 20);
}

function dataConfidenceFromResult(result) {
  const sourceStatus = result.breakdown?.sourceStatus;
  if (sourceStatus === 'public-rss' || sourceStatus === 'post-view+public-rss') {
    return {
      level: '높음',
      score: 88,
      sourceLabel: sourceStatus === 'post-view+public-rss' ? '개별 포스트 + 네이버 RSS 실측' : '네이버 RSS 실측',
      reason: sourceStatus === 'post-view+public-rss'
        ? '입력된 개별 포스트 본문과 최근 공개 RSS 글을 함께 읽어 계산했습니다.'
        : '최근 공개 RSS 글을 직접 읽어 주제, 활동성, 광고 신호를 계산했습니다.',
    };
  }
  if (sourceStatus === 'post-only') {
    return {
      level: '보통',
      score: 68,
      sourceLabel: '개별 포스트 실측',
      reason: '입력된 개별 포스트 본문은 읽었지만 최근 RSS 보조 신호가 부족합니다.',
    };
  }
  if (sourceStatus === 'limited') {
    return {
      level: '낮음',
      score: 32,
      sourceLabel: '접근 제한',
      reason: '공개 데이터 접근이 제한되어 추정 신호 비중이 큽니다.',
    };
  }
  return {
    level: '보통',
    score: 58,
    sourceLabel: '공개 신호 추정',
    reason: 'RSS 실측이 부족해 공개 패턴 기반 추정값을 함께 사용했습니다.',
  };
}

function strengthenEvaluation(result, legacyIndexInput = '') {
  const dataConfidence = dataConfidenceFromResult(result);
  const legacyIndex = normalizeLegacyIndex(legacyIndexInput);
  const verificationFlags = [];
  let scorePenalty = 0;
  let gradeCap = null;

  if (result.grade === 'S') gradeCap = 'A';

  if (dataConfidence.level === '낮음') {
    verificationFlags.push('데이터 신뢰도 낮음');
    scorePenalty += 16;
    gradeCap = minGrade(gradeCap, 'B');
  } else if (dataConfidence.level === '보통') {
    verificationFlags.push('추정 데이터 포함');
    scorePenalty += 7;
  }

  if (legacyIndex === '초급' && ['S', 'A'].includes(result.grade)) {
    verificationFlags.push('기존 지수 초급 대비 DEXOR 고득점');
    scorePenalty += 10;
    gradeCap = minGrade(gradeCap, 'B');
  } else if (legacyIndex === '중급' && result.grade === 'S') {
    verificationFlags.push('기존 지수 중급 대비 DEXOR S등급');
    scorePenalty += 5;
  }

  if (result.riskFlags.length > 0) {
    verificationFlags.push(...result.riskFlags);
    if (result.grade === 'S') gradeCap = minGrade(gradeCap, 'A');
  }

  const strengthenedScore = Math.round(clamp(result.score - scorePenalty));
  const scoreGrade = gradeFromScore(strengthenedScore);
  const strengthenedGrade = minGrade(scoreGrade, gradeCap || result.grade);
  const status = strengthenedGrade === result.grade ? '유지' : `${result.grade} -> ${strengthenedGrade}`;

  return {
    ...result,
    originalGrade: result.grade,
    originalScore: result.score,
    strengthenedScore,
    strengthenedGrade,
    strengthenedDecision: decisionFromGrade(strengthenedGrade),
    dataConfidence,
    legacyIndex,
    verificationFlags: [...new Set(verificationFlags)],
    gradeStatus: status,
    searchValidation: {
      status: '미검증',
      label: '최근 상위노출 검증 미완료',
    },
  };
}

function stripHtml(input = '') {
  return String(input).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function collectPublicBlogSignals(url, mode, campaign) {
  const blogId = getBlogId(url);
  if (!blogId) throw new Error('유효한 네이버 블로그 ID를 찾지 못했습니다.');

  const response = await fetch(`https://rss.blog.naver.com/${encodeURIComponent(blogId)}.xml`, {
    signal: AbortSignal.timeout(4500),
    headers: { 'User-Agent': 'DEXOR exposure analysis bot' },
  });
  if (!response.ok) throw new Error(`네이버 RSS 접근 실패 (${response.status})`);
  const xml = await response.text();
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
  const rawItems = asArray(parsed?.rss?.channel?.item).slice(0, mode === 'deep' ? 30 : 12);
  if (rawItems.length === 0) throw new Error('분석 가능한 공개 RSS 글이 없습니다.');
  const seed = hash(`${url}:${mode}:${campaign.industry}:${campaign.keyword}`);
  const industryWords = INDUSTRY_KEYWORDS[campaign.industry] || [];
  const posts = rawItems.map((item, index) => {
    const title = stripHtml(item.title);
    const description = stripHtml(item.description);
    const body = `${title} ${description}`;
    const pubDate = item.pubDate ? new Date(item.pubDate) : null;
    const daysAgo = pubDate && !Number.isNaN(pubDate.getTime())
      ? Math.max(0, Math.floor((Date.now() - pubDate.getTime()) / (1000 * 60 * 60 * 24)))
      : index * 7;
    const adSignals = ['제공', '협찬', '광고', '체험단', '원고료', '소정의'].filter((word) => body.includes(word));
    return {
      title: title || `${campaign.keyword} 공개 글 ${index + 1}`,
      description,
      daysAgo,
      topicHits: weightedTopicScore(body, [...industryWords, campaign.keyword]),
      hasExperience: ['방문', '사용', '먹어', '다녀', '직접', '후기', '느꼈'].some((word) => body.includes(word)),
      adSignals: adSignals.length ? adSignals : ['공개 글'],
      comments: 2 + ((seed + index) % 16),
      likes: 5 + ((seed + index * 7) % 45),
    };
  });
  return {
    sourceStatus: 'public-rss',
    subscriberSignal: 30 + (seed % 65),
    dailyVisitorSignal: estimateDailyVisitorSignal(posts, seed),
    topCompetitorStrength: 42 + (hash(`${campaign.keyword}:competition`) % 49),
    posts,
  }
}

function dailyVisitorOverrideFor(url, overrides = {}) {
  const normalizedUrl = normalizeBlogUrl(url);
  const blogId = getBlogId(url);
  return parseDailyVisitorValue(overrides[normalizedUrl])
    || parseDailyVisitorValue(overrides[blogId])
    || null;
}

function measuredDailyVisitorSignal(value) {
  const dailyVisitors = parseDailyVisitorValue(value);
  if (!dailyVisitors) return null;
  return {
    status: 'measured',
    label: '업로드 리스트 실측',
    estimatedAverage: dailyVisitors,
    estimatedMin: dailyVisitors,
    estimatedMax: dailyVisitors,
    minimums: DAILY_VISITOR_MINIMUMS,
  };
}

async function analyzeExposurePotential(url, mode = 'quick', campaignInput = {}) {
  const campaign = normalizeCampaign(campaignInput);
  const visitorOverride = dailyVisitorOverrideFor(url, campaignInput.dailyVisitorOverrides);
  const seed = hash(`${url}:${mode}:${campaign.industry}:${campaign.keyword}`);
  const [rssSignals, postSignals] = await Promise.all([
    collectPublicBlogSignals(url, mode, campaign).catch(() => null),
    collectPostSignals(url, campaign).catch(() => null),
  ]);
  if (!rssSignals && !postSignals) throw new Error('분석 가능한 공개 블로그/포스트 데이터를 찾지 못했습니다.');
  const signals = rssSignals || {
    sourceStatus: 'post-only',
    subscriberSignal: 35 + (seed % 35),
    dailyVisitorSignal: null,
    topCompetitorStrength: 42 + (hash(`${campaign.keyword}:competition`) % 49),
    posts: [{
      title: postSignals.title,
      daysAgo: 0,
      topicHits: Math.max(1, Math.round((postSignals.topicFit || 0) / 25)),
      hasExperience: postSignals.experienceFit >= 45,
      adSignals: postSignals.adSignals.length ? postSignals.adSignals : ['개별 포스트'],
      comments: 2 + (seed % 8),
      likes: 5 + (seed % 18),
    }],
  };
  const dailyVisitorSignal = measuredDailyVisitorSignal(visitorOverride) || signals.dailyVisitorSignal;
  const latestPostDays = Math.min(...signals.posts.map((post) => post.daysAgo));
  const recentPostCount = signals.posts.filter((post) => post.daysAgo <= 30).length;
  const adPostCount = signals.posts.filter((post) => post.adSignals.some((signal) => ['제공', '협찬', '광고'].includes(signal))).length;
  const adRatio = Math.round((adPostCount / signals.posts.length) * 100);
  const industryWords = keywordTerms(campaign);
  const recentTenPosts = signals.posts.slice(0, 10);
  const recentFivePosts = signals.posts.slice(0, 5);
  const searchTerms = keywordSearchTerms(campaign);
  const recentFiveKeywordHitPosts = recentFivePosts
    .map((post, index) => ({
      index: index + 1,
      title: post.title,
      matched: textIncludesAnyTerm(`${post.title || ''} ${post.description || ''}`, searchTerms),
    }))
    .filter((post) => post.matched);
  const recentKeywordHitPosts = recentTenPosts
    .map((post, index) => ({
      index: index + 1,
      title: post.title,
      matched: textIncludesAnyTerm(`${post.title || ''} ${post.description || ''}`, searchTerms),
    }))
    .filter((post) => post.matched);
  const recentKeywordCoverage = signals.posts.length
    ? Math.round((recentKeywordHitPosts.length / Math.min(10, signals.posts.length)) * 100)
    : 0;
  const recentKeywordCheck = {
    status: recentKeywordHitPosts.length > 0 ? 'passed' : 'failed',
    label: recentKeywordHitPosts.length > 0 ? '최근 10개 내 키워드 콘텐츠 확인' : '최근 10개 내 키워드 콘텐츠 없음',
    coverage: recentKeywordCoverage,
    matchedCount: recentKeywordHitPosts.length,
    recentFiveMatchedCount: recentFiveKeywordHitPosts.length,
    checkedCount: Math.min(10, signals.posts.length),
    recentFiveCheckedCount: Math.min(5, signals.posts.length),
    terms: searchTerms,
    matchedTitles: recentKeywordHitPosts.slice(0, 3).map((post) => post.title),
    recentFiveMatchedTitles: recentFiveKeywordHitPosts.slice(0, 3).map((post) => post.title),
  };
  const derivedKeywords = extractCandidateKeywords(recentFivePosts, campaign, 2);
  const derivedKeywordBonus = Math.min(8, derivedKeywords.reduce((sum, item) => sum + item.weight, 0) / 4);
  const topicHits = signals.posts.reduce((sum, post) => sum + post.topicHits + weightedTopicScore(post.title, industryWords), 0);
  const maxTopicHits = signals.posts.length * 5;
  const topicFit = Math.round(clamp((topicHits / maxTopicHits) * 100));
  const activityFit = Math.round(clamp((recentPostCount / Math.min(signals.posts.length, mode === 'deep' ? 16 : 8)) * 100));
  const experienceFit = Math.round((signals.posts.filter((post) => post.hasExperience).length / signals.posts.length) * 100);
  const engagementFit = Math.round(clamp((signals.posts.reduce((sum, post) => sum + post.comments + post.likes / 4, 0) / signals.posts.length) * 3));
  const keywordCompetition = signals.topCompetitorStrength;
  const competitorSimilarity = Math.round(clamp((topicFit * 0.45) + (activityFit * 0.25) + (experienceFit * 0.2) + (engagementFit * 0.1) - Math.max(0, keywordCompetition - 70) * 0.35));
  const cRankFit = Math.round(clamp(topicFit * 0.42 + activityFit * 0.28 + engagementFit * 0.18 + signals.subscriberSignal * 0.12));
  const diaFit = Math.round(clamp(experienceFit * 0.36 + topicFit * 0.28 + (100 - adRatio) * 0.16 + activityFit * 0.12 + competitorSimilarity * 0.08));
  const riskFlags = [];
  let riskPenalty = 0;
  let gradeCap = null;

  if (signals.sourceStatus === 'limited') {
    riskFlags.push('공개 데이터 접근 제한');
    riskPenalty += 18;
    gradeCap = minGrade(gradeCap, 'B');
  }
  if (latestPostDays > 45) {
    riskFlags.push('최근 활동 약함');
    riskPenalty += 14;
  }
  if (adRatio >= 65) {
    riskFlags.push('대가성 콘텐츠 비중 높음');
    riskPenalty += 10;
  }
  if (topicFit < 35) {
    riskFlags.push(postSignals ? '블로그 최근 주제 흐름 약함' : '캠페인 주제 적합도 낮음');
    riskPenalty += postSignals ? 6 : 10;
  }
  if (recentKeywordCheck.status === 'failed') {
    riskFlags.push('최근 10개 내 키워드 콘텐츠 없음');
    riskPenalty += 10;
  } else if (recentKeywordCheck.recentFiveMatchedCount === 0) {
    riskFlags.push('최근 5개 내 세부키워드 노출 없음');
    riskPenalty += 7;
  } else if (recentKeywordCheck.matchedCount === 1 && signals.posts.length >= 8) {
    riskFlags.push('최근 키워드 콘텐츠 빈도 낮음');
    riskPenalty += 4;
  }
  if (!dailyVisitorSignal) {
    riskFlags.push('일방문자수 실측 미확인');
    riskPenalty += 2;
  } else if ((dailyVisitorSignal.estimatedAverage || 0) < DAILY_VISITOR_MINIMUMS.b) {
    riskFlags.push('일방문자수 기준 미달');
    riskPenalty += 8;
  } else if ((dailyVisitorSignal.estimatedAverage || 0) < DAILY_VISITOR_MINIMUMS.a) {
    riskFlags.push('일방문자수 낮음');
    riskPenalty += 6;
  } else if ((dailyVisitorSignal.estimatedAverage || 0) < DAILY_VISITOR_MINIMUMS.s) {
    riskFlags.push('S랭크 방문자 기준 미달');
    riskPenalty += 3;
  }
  if (postSignals && postSignals.topicFit < 35) {
    riskFlags.push('개별 포스트 주제 적합도 낮음');
    riskPenalty += 8;
  }
  if (keywordCompetition >= 82 && competitorSimilarity < 68) {
    riskFlags.push('키워드 경쟁 강도 높음');
    riskPenalty += 6;
  }

  const rssScore = cRankFit * 0.36 + diaFit * 0.34 + competitorSimilarity * 0.2 + (100 - keywordCompetition) * 0.1;
  const exposureScore = postSignals
    ? Math.round(clamp(postSignals.postFit * 0.6 + cRankFit * 0.14 + diaFit * 0.12 + competitorSimilarity * 0.07 + activityFit * 0.04 + recentKeywordCoverage * 0.03 + derivedKeywordBonus - riskPenalty * 0.35))
    : Math.round(clamp(rssScore + recentKeywordCoverage * 0.05 + derivedKeywordBonus - riskPenalty));
  const dailyVisitorAverage = dailyVisitorSignal?.estimatedAverage || 0;
  const strongRecentTopicExposure = recentKeywordCheck.recentFiveMatchedCount >= 2 || recentKeywordCheck.matchedCount >= 4;
  const severeExposureRisk = Boolean(signals.sourceStatus === 'limited'
    || latestPostDays > 45
    || adRatio >= 65
    || topicFit < 25
    || (dailyVisitorSignal && dailyVisitorAverage < DAILY_VISITOR_MINIMUMS.b)
    || (postSignals && postSignals.topicFit < 25));
  const exposureSignal = {
    status: strongRecentTopicExposure && !severeExposureRisk ? 'strong' : 'normal',
    label: strongRecentTopicExposure && !severeExposureRisk ? '최근 주제 노출 강함' : '종합 점수 기준',
    recentFiveMatchedCount: recentKeywordCheck.recentFiveMatchedCount,
    matchedCount: recentKeywordCheck.matchedCount,
    severeExposureRisk,
  };
  const scoreGrade = gradeFromScore(exposureScore);
  const grade = exposureSignal.status === 'strong' && !gradeCap ? 'S' : minGrade(scoreGrade, gradeCap);
  const recommendation = ['S', 'A'].includes(grade)
    ? '체험 후기형 원고'
    : grade === 'B'
      ? '롱테일 키워드 후기'
      : '브랜드 인지도 보조 캠페인';
  const reasons = [
    postSignals
      ? `입력된 개별 포스트 "${postSignals.title || postSignals.logNo}" 본문을 직접 읽어 포스트 적합도 ${postSignals.postFit}점을 반영했습니다.`
      : `${campaign.industryLabel}·${campaign.keyword} 맥락에서 최근 ${recentPostCount}개 글이 공개 신호로 확인되어 노출 가능성을 추정했습니다.`,
    `블로그 최근 글 기준 주제 적합도 ${topicFit}점, 문서 적합도 ${diaFit}점으로 블로그 전체 흐름을 보조 반영했습니다.`,
    `${recentKeywordCheck.label}: 최근 ${recentKeywordCheck.checkedCount}개 중 ${recentKeywordCheck.matchedCount}개, 최근 5개 중 ${recentKeywordCheck.recentFiveMatchedCount}개가 "${campaign.keyword}" 관련 표현을 포함했습니다.`,
    derivedKeywords.length
      ? `최근 5개 글에서 보조 검토 키워드로 ${derivedKeywords.map((item) => item.keyword).join(', ')}를 추렸습니다.`
      : '최근 5개 글에서 뚜렷한 보조 검토 키워드는 추출되지 않았습니다.',
    keywordCompetition >= 75
      ? `입력 키워드의 경쟁 강도가 ${keywordCompetition}점으로 높아 상위 노출은 보수적으로 봐야 합니다.`
      : `입력 키워드 경쟁 강도가 ${keywordCompetition}점으로 과열 구간은 아닙니다.`,
  ];
  const cautionReasons = riskFlags.length
    ? riskFlags.map((flag) => `${flag} 신호가 있어 원고 주제와 제목 설계를 보수적으로 잡아야 합니다.`)
    : ['큰 위험 신호는 없지만 실제 발행 전 최신 글 톤과 댓글 반응을 다시 확인하는 편이 좋습니다.'];

  return {
    id: `result_${Date.now()}_${seed}`,
    url,
    mode,
    score: exposureScore,
    grade,
    decision: decisionFromGrade(grade),
    adRatio,
    recentActivity: latestPostDays <= 7 ? '매우 활발' : latestPostDays <= 30 ? '활발' : latestPostDays <= 60 ? '주의' : '비활성',
    category: campaign.industryLabel,
    riskFlags,
    reasons,
    breakdown: {
      exposureScore,
      cRankFit,
      diaFit,
      topicFit,
      keywordCompetition,
      competitorSimilarity,
      activityFit,
      postFit: postSignals?.postFit ?? null,
      postTopicFit: postSignals?.topicFit ?? null,
      postExperienceFit: postSignals?.experienceFit ?? null,
      postQualityFit: postSignals?.qualityFit ?? null,
      postSignals,
      riskPenalty,
      campaign,
      recentPostCount,
      latestPostDays,
      recentKeywordCheck,
      derivedKeywords,
      dailyVisitorSignal,
      exposureSignal,
      sourceStatus: postSignals && rssSignals ? 'post-view+public-rss' : postSignals ? 'post-only' : signals.sourceStatus,
      recommendation,
      cautionReasons,
    },
    recentPosts: signals.posts.slice(0, 5).map((post) => ({
      title: post.title,
      adSignals: post.adSignals,
      comments: post.comments,
      daysAgo: post.daysAgo,
    })),
  };
}

function createJob(userId, urls, mode = 'quick', campaignInput = {}) {
  const uniqueUrls = [...new Set(urls.map(normalizeBlogUrl).filter(Boolean))];
  if (uniqueUrls.length === 0) {
    const error = new Error('분석할 네이버 블로그 URL을 찾지 못했습니다.');
    error.status = 400;
    error.payload = { message: error.message };
    throw error;
  }
  const creditCost = uniqueUrls.length * CREDIT_COST[mode];
  const jobId = id('job');
  if (!spendCredits(userId, creditCost, `analysis:${mode}`, jobId)) {
    const credits = getCredits(userId);
    const shortage = Math.max(0, creditCost - credits.remaining);
    const error = new Error('크레딧이 부족합니다.');
    error.status = 402;
    error.payload = { message: error.message, required: creditCost, remaining: credits.remaining, shortage, packages: CREDIT_PACKAGES };
    throw error;
  }
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO analysis_jobs (id, user_id, mode, status, total, completed, failed, credit_cost, created_at)
    VALUES (?, ?, ?, 'pending', ?, 0, 0, ?, ?)
  `).run(jobId, userId, mode, uniqueUrls.length, creditCost, timestamp);
  queue.push({
    jobId,
    userId,
    urls: uniqueUrls,
    mode,
    campaign: normalizeCampaign(campaignInput),
    dailyVisitorOverrides: normalizeDailyVisitorOverrides(campaignInput.dailyVisitorOverrides),
    categoryOverrides: normalizeCategoryOverrides(campaignInput.categoryOverrides),
  });
  drainQueue();
  return getJob(jobId, userId);
}

function getJob(jobId, userId) {
  return db.prepare(`
    SELECT id, mode, status, total, completed, failed, credit_cost as creditCost,
      credit_refunded as creditRefunded, created_at as createdAt, completed_at as completedAt
    FROM analysis_jobs
    WHERE id = ? AND user_id = ?
  `).get(jobId, userId);
}

function drainQueue() {
  while (activeWorkers < CONCURRENCY && queue.length > 0) {
    const task = queue.shift();
    activeWorkers += 1;
    processTask(task).finally(() => {
      activeWorkers -= 1;
      drainQueue();
    });
  }
}

async function processTask(task) {
  const job = db.prepare('SELECT * FROM analysis_jobs WHERE id = ? AND user_id = ?').get(task.jobId, task.userId);
  if (!job) return;
  db.prepare('UPDATE analysis_jobs SET status = ? WHERE id = ?').run('processing', task.jobId);
  for (const url of task.urls) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    try {
      const urlCategoryOverride = task.categoryOverrides[normalizeBlogUrl(url)] || task.categoryOverrides[getBlogId(url)];
      const campaign = urlCategoryOverride
        ? normalizeCampaign({
          ...task.campaign,
          industry: urlCategoryOverride,
          keyword: task.campaign.keywordProvided ? task.campaign.keyword : '',
        })
        : task.campaign;
      const result = await analyzeExposurePotential(url, task.mode, {
        ...campaign,
        dailyVisitorOverrides: task.dailyVisitorOverrides,
      });
      db.prepare(`
        INSERT INTO blog_results (
          id, job_id, user_id, url, mode, score, grade, decision, ad_ratio,
          recent_activity, category, risk_flags, reasons, breakdown, recent_posts, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.id,
        task.jobId,
        task.userId,
        result.url,
        result.mode,
        result.score,
        result.grade,
        result.decision,
        result.adRatio,
        result.recentActivity,
        result.category,
        JSON.stringify(result.riskFlags),
        JSON.stringify(result.reasons),
        JSON.stringify(result.breakdown),
        JSON.stringify(result.recentPosts),
        nowIso(),
      );
      db.prepare('UPDATE analysis_jobs SET completed = completed + 1 WHERE id = ?').run(task.jobId);
    } catch {
      db.prepare('UPDATE analysis_jobs SET failed = failed + 1 WHERE id = ?').run(task.jobId);
    }
  }
  const finalJob = db.prepare('SELECT * FROM analysis_jobs WHERE id = ?').get(task.jobId);
  const failedAll = finalJob.failed === finalJob.total;
  const refundAmount = finalJob.failed * CREDIT_COST[task.mode];
  if (refundAmount > 0 && !finalJob.credit_refunded) {
    addCredits(task.userId, refundAmount, 'analysis_refund', task.jobId);
    db.prepare('UPDATE analysis_jobs SET credit_refunded = 1 WHERE id = ?').run(task.jobId);
  }
  db.prepare('UPDATE analysis_jobs SET status = ?, completed_at = ? WHERE id = ?')
    .run(failedAll ? 'failed' : 'completed', nowIso(), task.jobId);
}

function mapResult(row) {
  const breakdown = JSON.parse(row.breakdown);
  return {
    id: row.id,
    jobId: row.job_id,
    url: row.url,
    mode: row.mode,
    score: row.score,
    grade: row.grade,
    decision: row.decision,
    adRatio: row.ad_ratio,
    recentActivity: row.recent_activity,
    category: row.category,
    riskFlags: JSON.parse(row.risk_flags),
    reasons: JSON.parse(row.reasons),
    breakdown,
    recentPosts: JSON.parse(row.recent_posts),
    exposureScore: breakdown.exposureScore ?? row.score,
    cRankFit: breakdown.cRankFit ?? null,
    diaFit: breakdown.diaFit ?? null,
    topicFit: breakdown.topicFit ?? null,
    postFit: breakdown.postFit ?? null,
    postTopicFit: breakdown.postTopicFit ?? null,
    postExperienceFit: breakdown.postExperienceFit ?? null,
    postQualityFit: breakdown.postQualityFit ?? null,
    postSignals: breakdown.postSignals ?? null,
    keywordCompetition: breakdown.keywordCompetition ?? null,
    competitorSimilarity: breakdown.competitorSimilarity ?? null,
    campaign: breakdown.campaign ?? null,
    recentPostCount: breakdown.recentPostCount ?? null,
    latestPostDays: breakdown.latestPostDays ?? null,
    recentKeywordCheck: breakdown.recentKeywordCheck ?? null,
    derivedKeywords: breakdown.derivedKeywords ?? [],
    dailyVisitorSignal: breakdown.dailyVisitorSignal ?? null,
    sourceStatus: breakdown.sourceStatus ?? 'public',
    recommendation: breakdown.recommendation ?? null,
    cautionReasons: breakdown.cautionReasons ?? [],
  };
}

function storeOAuthState(provider) {
  const state = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO oauth_states (state, provider, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(state, provider, new Date(Date.now() + 1000 * 60 * 10).toISOString(), nowIso());
  return state;
}

function consumeOAuthState(state, provider) {
  const row = db.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider = ? AND expires_at > ?')
    .get(state, provider, nowIso());
  if (!row) return false;
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  return true;
}

function ensureProviderConfigured(res, provider, hasKeys) {
  if (hasKeys || !isProduction) return true;
  res.status(503).json({ message: `${provider} OAuth 설정이 필요합니다.` });
  return false;
}

function oauthRedirect(res, provider, authUrl, devProfile) {
  if (authUrl) return res.redirect(authUrl);
  if (isProduction) return res.status(503).json({ message: `${provider} OAuth 설정이 필요합니다.` });
  const user = upsertOAuthUser(devProfile);
  setSession(res, user.id);
  return res.redirect(`${APP_URL}/?login=dev-${provider}`);
}

async function exchangeNaverCode(code) {
  const tokenUrl = new URL('https://nid.naver.com/oauth2.0/token');
  tokenUrl.searchParams.set('grant_type', 'authorization_code');
  tokenUrl.searchParams.set('client_id', process.env.NAVER_CLIENT_ID);
  tokenUrl.searchParams.set('client_secret', process.env.NAVER_CLIENT_SECRET);
  tokenUrl.searchParams.set('code', code);
  const token = await fetch(tokenUrl).then((res) => res.json());
  if (!token.access_token) throw new Error('네이버 토큰 발급에 실패했습니다.');
  const profile = await fetch('https://openapi.naver.com/v1/nid/me', {
    headers: { Authorization: `Bearer ${token.access_token}` },
  }).then((res) => res.json());
  const body = profile.response;
  return {
    provider: 'naver',
    providerUserId: body.id,
    email: body.email,
    name: body.name || body.nickname || body.email,
    avatarUrl: body.profile_image,
  };
}

async function exchangeGoogleCode(code) {
  const token = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${API_URL}/api/auth/google/callback`,
      code,
    }),
  }).then((res) => res.json());
  if (!token.access_token) throw new Error('구글 토큰 발급에 실패했습니다.');
  const profile = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${token.access_token}` },
  }).then((res) => res.json());
  return {
    provider: 'google',
    providerUserId: profile.sub,
    email: profile.email,
    name: profile.name || profile.email,
    avatarUrl: profile.picture,
  };
}

function getPackage(packageId) {
  return CREDIT_PACKAGES.find((item) => item.id === packageId);
}

async function approveTossPayment({ paymentKey, orderId, amount }) {
  if (!process.env.TOSS_SECRET_KEY) {
    if (isProduction) throw new Error('Toss 결제 secret 설정이 필요합니다.');
    return {
      paymentKey,
      orderId,
      status: 'WAITING_FOR_DEPOSIT',
      secret: `dev_secret_${orderId}`,
      virtualAccount: {
        accountNumber: '12345678901234',
        bankCode: '088',
        customerName: 'DEXOR',
        dueDate: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
      },
    };
  }
  const auth = Buffer.from(`${process.env.TOSS_SECRET_KEY}:`).toString('base64');
  const response = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ paymentKey, orderId, amount }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || 'Toss 결제 승인에 실패했습니다.');
  return payload;
}

app.get('/api/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.json({ user: null, credits: null });
  res.json({ user, credits: getCredits(user.id) });
});

app.get('/api/auth/naver/start', (req, res) => {
  const hasKeys = process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET;
  if (!ensureProviderConfigured(res, 'Naver', hasKeys)) return;
  const state = storeOAuthState('naver');
  const authUrl = hasKeys ? new URL('https://nid.naver.com/oauth2.0/authorize') : null;
  if (authUrl) {
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', process.env.NAVER_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', `${API_URL}/api/auth/naver/callback`);
    authUrl.searchParams.set('state', state);
  }
  oauthRedirect(res, 'naver', authUrl?.toString(), {
    provider: 'naver',
    providerUserId: 'dev_naver_user',
    email: 'naver.demo@dexor.ai',
    name: '네이버 데모 사용자',
  });
});

app.get('/api/auth/naver/callback', async (req, res) => {
  try {
    if (!consumeOAuthState(req.query.state, 'naver')) return res.redirect(`${APP_URL}/?auth_error=state`);
    const user = upsertOAuthUser(await exchangeNaverCode(req.query.code));
    setSession(res, user.id);
    res.redirect(APP_URL);
  } catch (error) {
    res.redirect(`${APP_URL}/?auth_error=${encodeURIComponent(error.message)}`);
  }
});

app.get('/api/auth/google/start', (req, res) => {
  const hasKeys = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET;
  if (!ensureProviderConfigured(res, 'Google', hasKeys)) return;
  const state = storeOAuthState('google');
  const authUrl = hasKeys ? new URL('https://accounts.google.com/o/oauth2/v2/auth') : null;
  if (authUrl) {
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', `${API_URL}/api/auth/google/callback`);
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('state', state);
  }
  oauthRedirect(res, 'google', authUrl?.toString(), {
    provider: 'google',
    providerUserId: 'dev_google_user',
    email: 'google.demo@dexor.ai',
    name: 'Google Demo User',
  });
});

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    if (!consumeOAuthState(req.query.state, 'google')) return res.redirect(`${APP_URL}/?auth_error=state`);
    const user = upsertOAuthUser(await exchangeGoogleCode(req.query.code));
    setSession(res, user.id);
    res.redirect(APP_URL);
  } catch (error) {
    res.redirect(`${APP_URL}/?auth_error=${encodeURIComponent(error.message)}`);
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

app.get('/api/dashboard', requireAuth, (req, res) => {
  const recentProjects = db.prepare(`
    SELECT id, mode, status, total, completed, failed, created_at as createdAt
    FROM analysis_jobs
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 5
  `).all(req.user.id);
  const analysisCount = db.prepare('SELECT COUNT(*) as count FROM analysis_jobs WHERE user_id = ?').get(req.user.id).count;
  res.json({ credits: getCredits(req.user.id), analysisCount, recentProjects });
});

app.post('/api/analyze/single', requireAuth, (req, res) => {
  try {
    const url = normalizeBlogUrl(req.body.url);
    if (!url) return res.status(400).json({ message: 'blog.naver.com URL이 필요합니다.' });
    res.status(202).json(createJob(req.user.id, [url], 'quick', req.body));
  } catch (error) {
    res.status(error.status || 500).json(error.payload || { message: error.message });
  }
});

app.post('/api/analyze/bulk', requireAuth, handleUpload, async (req, res) => {
  try {
    const pastedUrls = extractUrlsFromText(req.body.urls || '');
    const pastedDailyVisitors = extractDailyVisitorsFromRows(extractRowsFromText(req.body.urls || ''));
    const uploadSignals = req.file ? await extractUploadSignals(req.file) : { urls: [], dailyVisitors: {}, categoryOverrides: {} };
    const urls = [...new Set([...pastedUrls, ...uploadSignals.urls])];
    if (urls.length === 0) return res.status(400).json({ message: '분석할 네이버 블로그 URL을 찾지 못했습니다.' });
    res.status(202).json(createJob(req.user.id, urls, 'quick', {
      ...req.body,
      dailyVisitorOverrides: mergeMaps(pastedDailyVisitors, uploadSignals.dailyVisitors),
      categoryOverrides: uploadSignals.categoryOverrides,
    }));
  } catch (error) {
    res.status(error.status || 500).json(error.payload || { message: error.message });
  }
});

app.post('/api/analyze/deep', requireAuth, (req, res) => {
  try {
    const urls = Array.isArray(req.body.urls) ? req.body.urls : [];
    if (urls.length === 0) return res.status(400).json({ message: '정밀 분석할 URL을 선택해주세요.' });
    res.status(202).json(createJob(req.user.id, urls, 'deep', req.body));
  } catch (error) {
    res.status(error.status || 500).json(error.payload || { message: error.message });
  }
});

app.post('/api/analyze/test-strengthened', requireAuth, async (req, res) => {
  try {
    const urls = Array.isArray(req.body.urls) ? req.body.urls : extractUrlsFromText(req.body.urls || '');
    const uniqueUrls = [...new Set(urls.map(normalizeBlogUrl).filter(Boolean))].slice(0, 20);
    const legacyIndexes = req.body.legacyIndexes && typeof req.body.legacyIndexes === 'object' ? req.body.legacyIndexes : {};
    const dailyVisitorOverrides = mergeMaps(
      normalizeDailyVisitorOverrides(req.body.dailyVisitorOverrides),
      extractDailyVisitorsFromRows(extractRowsFromText(req.body.urls || '')),
    );
    if (uniqueUrls.length === 0) return res.status(400).json({ message: '테스트할 네이버 블로그 URL을 찾지 못했습니다.' });

    const results = [];
    for (const url of uniqueUrls) {
      const result = await analyzeExposurePotential(url, 'quick', { ...req.body, dailyVisitorOverrides });
      results.push(strengthenEvaluation(result, legacyIndexes[url] || legacyIndexes[getBlogId(url)] || ''));
    }
    res.json({ results });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = getJob(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ message: '작업을 찾을 수 없습니다.' });
  res.json(job);
});

app.get('/api/results/:id', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM blog_results WHERE job_id = ? AND user_id = ? ORDER BY created_at ASC')
    .all(req.params.id, req.user.id);
  res.json({ results: rows.map(mapResult) });
});

app.get('/api/export', requireAuth, (req, res) => {
  const jobId = req.query.jobId;
  const rows = jobId
    ? db.prepare('SELECT * FROM blog_results WHERE job_id = ? AND user_id = ? ORDER BY created_at ASC').all(jobId, req.user.id)
    : db.prepare('SELECT * FROM blog_results WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  const results = rows.map(mapResult);
  const header = [
    'URL',
    'ExposureScore',
    'Grade',
    'Decision',
    'Industry',
    'Keyword',
    'PostFit',
    'PostTopicFit',
    'TopicFit',
    'KeywordCompetition',
    'RecentActivity',
    'RecentPostCount',
    'Recent5KeywordHits',
    'Recent10KeywordHits',
    'DerivedKeywords',
    'DailyVisitorSignal',
    'Recommendation',
    'Reasons',
    'Cautions',
  ];
  const csvRows = results.map((item) => [
    item.url,
    item.exposureScore,
    item.grade,
    item.decision,
    item.category,
    item.campaign?.keyword || '',
    item.postFit ?? '',
    item.postTopicFit ?? '',
    item.topicFit ?? '',
    item.keywordCompetition ?? '',
    item.recentActivity,
    item.recentPostCount ?? '',
    item.recentKeywordCheck
      ? `${item.recentKeywordCheck.recentFiveMatchedCount}/${item.recentKeywordCheck.recentFiveCheckedCount}`
      : '',
    item.recentKeywordCheck
      ? `${item.recentKeywordCheck.matchedCount}/${item.recentKeywordCheck.checkedCount}`
      : '',
    item.derivedKeywords.map((keyword) => keyword.keyword).join(' / '),
    item.dailyVisitorSignal
      ? `${item.dailyVisitorSignal.label} avg ${item.dailyVisitorSignal.estimatedAverage} (${item.dailyVisitorSignal.estimatedMin}-${item.dailyVisitorSignal.estimatedMax})`
      : '미확인',
    item.recommendation || '',
    item.reasons.join(' / '),
    item.cautionReasons.join(' / '),
  ]);
  const csv = [header, ...csvRows]
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
    .join('\n');
  res.header('Content-Type', 'text/csv; charset=utf-8');
  res.attachment('dexor-results.csv');
  res.send(`\uFEFF${csv}`);
});

app.get('/api/billing/packages', requireAuth, (_req, res) => {
  res.json({ packages: CREDIT_PACKAGES });
});

app.get('/api/billing/payments', requireAuth, (req, res) => {
  const payments = db.prepare(`
    SELECT id, package_id as packageId, order_id as orderId, amount, credits, status,
      payment_key as paymentKey, virtual_account_json as virtualAccountJson, created_at as createdAt, updated_at as updatedAt
    FROM payments
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(req.user.id).map((payment) => ({
    ...payment,
    virtualAccount: payment.virtualAccountJson ? JSON.parse(payment.virtualAccountJson) : null,
    virtualAccountJson: undefined,
  }));
  res.json({ payments });
});

app.post('/api/billing/checkout/virtual-account', requireAuth, (req, res) => {
  if (isProduction && (!process.env.TOSS_CLIENT_KEY || !process.env.TOSS_SECRET_KEY)) {
    return res.status(503).json({ message: 'Toss 결제 설정이 필요합니다.' });
  }
  const selectedPackage = getPackage(req.body.packageId);
  if (!selectedPackage) return res.status(400).json({ message: '유효한 크레딧 상품을 선택해주세요.' });
  const orderId = `DEXOR-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const paymentId = id('pay');
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO payments (id, user_id, package_id, order_id, provider, amount, credits, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'toss', ?, ?, 'created', ?, ?)
  `).run(paymentId, req.user.id, selectedPackage.id, orderId, selectedPackage.amount, selectedPackage.credits, timestamp, timestamp);
  res.status(201).json({
    payment: {
      id: paymentId,
      orderId,
      packageId: selectedPackage.id,
      amount: selectedPackage.amount,
      credits: selectedPackage.credits,
      status: 'created',
    },
    toss: {
      clientKey: process.env.TOSS_CLIENT_KEY || 'test_ck_dev_placeholder',
      method: 'VIRTUAL_ACCOUNT',
      successUrl: `${APP_URL}/billing/success`,
      failUrl: `${APP_URL}/billing/fail`,
    },
  });
});

app.post('/api/billing/toss/success', requireAuth, async (req, res) => {
  try {
    const { paymentKey, orderId, amount } = req.body;
    const payment = db.prepare('SELECT * FROM payments WHERE order_id = ? AND user_id = ?').get(orderId, req.user.id);
    if (!payment) return res.status(404).json({ message: '결제 주문을 찾을 수 없습니다.' });
    if (Number(amount) !== payment.amount) return res.status(400).json({ message: '결제 금액이 일치하지 않습니다.' });
    const approved = await approveTossPayment({ paymentKey, orderId, amount: Number(amount) });
    const status = approved.status === 'DONE' ? 'paid' : 'waiting_for_deposit';
    db.prepare(`
      UPDATE payments
      SET status = ?, payment_key = ?, secret = ?, virtual_account_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      approved.paymentKey,
      approved.secret || null,
      JSON.stringify(approved.virtualAccount || null),
      nowIso(),
      payment.id,
    );
    if (approved.status === 'DONE' && payment.status !== 'paid') {
      addCredits(payment.user_id, payment.credits, 'payment', payment.id);
    }
    const nextPayment = db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
    res.json({
      payment: {
        id: nextPayment.id,
        orderId: nextPayment.order_id,
        amount: nextPayment.amount,
        credits: nextPayment.credits,
        status: nextPayment.status,
        virtualAccount: nextPayment.virtual_account_json ? JSON.parse(nextPayment.virtual_account_json) : null,
      },
      credits: getCredits(req.user.id),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/webhooks/toss/deposit', (req, res) => {
  const { orderId, status, secret } = req.body;
  if (!['DONE', 'WAITING_FOR_DEPOSIT'].includes(status)) {
    return res.status(400).json({ message: '지원하지 않는 입금 상태입니다.' });
  }
  const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
  if (!payment) return res.status(404).json({ message: '결제를 찾을 수 없습니다.' });
  if (!payment.secret || payment.secret !== secret) return res.status(403).json({ message: '웹훅 secret이 일치하지 않습니다.' });
  if (status === 'DONE' && payment.status !== 'paid') {
    db.prepare('UPDATE payments SET status = ?, updated_at = ? WHERE id = ?').run('paid', nowIso(), payment.id);
    addCredits(payment.user_id, payment.credits, 'payment', payment.id);
  } else if (status === 'WAITING_FOR_DEPOSIT' && payment.status !== 'paid') {
    db.prepare('UPDATE payments SET status = ?, updated_at = ? WHERE id = ?').run('waiting_for_deposit', nowIso(), payment.id);
  }
  res.json({ ok: true });
});

if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(join(distDir, 'index.html'));
  });
}

const server = app.listen(PORT, () => {
  console.log(`DEXOR API running on http://127.0.0.1:${PORT}`);
});
server.ref();
