import crypto from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import cors from 'cors';
import express from 'express';
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import multer from 'multer';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 4000;
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5173';
const API_URL = process.env.API_URL || `http://127.0.0.1:${PORT}`;
const SESSION_COOKIE = 'dexor_session';
const CONCURRENCY = 5;
const CREDIT_COST = { quick: 1, deep: 3 };
const CREDIT_PACKAGES = [
  { id: 'credits_100', name: '100 크레딧', credits: 100, amount: 99000 },
  { id: 'credits_500', name: '500 크레딧', credits: 500, amount: 399000 },
  { id: 'credits_1000', name: '1000 크레딧', credits: 1000, amount: 699000 },
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, '..');
const distDir = join(appRoot, 'dist');
const dataDir = join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'dexor.sqlite'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

app.use(cors({ origin: APP_URL, credentials: true }));
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

function normalizeBlogUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const match = trimmed.match(/(?:https?:\/\/)?(?:m\.)?blog\.naver\.com\/([a-zA-Z0-9._-]+)/i);
  if (!match) return null;
  return `https://blog.naver.com/${match[1]}`;
}

function extractUrlsFromText(text = '') {
  const matches = text.match(/(?:https?:\/\/)?(?:m\.)?blog\.naver\.com\/[^\s"'<>),]+/gi) || [];
  return [...new Set(matches.map(normalizeBlogUrl).filter(Boolean))];
}

async function extractUrlsFromWorkbook(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  const found = [];
  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('text');
  const sharedStrings = [];
  if (sharedXml) {
    const shared = parser.parse(sharedXml);
    asArray(shared?.sst?.si).forEach((entry) => sharedStrings.push(readRichText(entry)));
  }
  const sheetFiles = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  for (const sheetFile of sheetFiles) {
    const xml = await zip.file(sheetFile).async('text');
    const sheet = parser.parse(xml);
    asArray(sheet?.worksheet?.sheetData?.row).forEach((row) => {
      asArray(row.c).forEach((cell) => {
        const text = cell.t === 's' ? sharedStrings[Number(cell.v)] : readRichText(cell.is) || cell.v;
        found.push(...extractUrlsFromText(String(text ?? '')));
      });
    });
  }
  return [...new Set(found)];
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function readRichText(entry) {
  if (!entry) return '';
  if (typeof entry.t === 'string' || typeof entry.t === 'number') return String(entry.t);
  return asArray(entry.r).map((run) => run.t ?? '').join('');
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
  if (grade === 'S') return '선정';
  if (grade === 'A') return '선정 가능';
  if (grade === 'B') return '보류';
  if (grade === 'C') return '제외 권장';
  return '사용 금지';
}

function analyzeBlog(url, mode = 'quick') {
  const seed = hash(`${url}:${mode}`);
  const daysSincePost = seed % 95;
  const inaccessible = seed % 41 === 0;
  const adRatio = Math.min(98, 12 + (seed % 81));
  const commentManipulation = seed % 17 === 0 || seed % 19 === 0;
  const categoryPool = ['맛집', '뷰티', '육아', '여행', '리빙', 'IT', '패션', '반려동물'];
  const category = categoryPool[seed % categoryPool.length];
  const postsToAnalyze = mode === 'deep' ? 45 : 10;
  const breakdown = {
    activity: Math.max(0, 20 - Math.floor(daysSincePost / 5)),
    responsiveness: Math.max(2, 15 - (seed % 13)),
    contentQuality: Math.max(4, 15 - (seed % 9)),
    adRisk: Math.max(0, 20 - Math.floor(adRatio / 5)),
    searchVisibility: Math.max(2, 20 - (seed % 16)),
    categoryFit: Math.max(3, 10 - (seed % 7)),
  };
  let score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  const riskFlags = [];
  const reasons = [];
  if (inaccessible) {
    score = 0;
    riskFlags.push('접근 불가');
    reasons.push('블로그를 확인할 수 없어 선정하기 어렵습니다.');
  }
  if (daysSincePost > 60) {
    score = Math.min(score, 39);
    riskFlags.push('최근 60일 글 없음');
    reasons.push('최근 글이 없어 체험단 진행 시 노출 기대치가 낮습니다.');
  }
  if (adRatio >= 90) {
    score = Math.min(score, 39);
    riskFlags.push('광고글 90% 이상');
    reasons.push('협찬성 콘텐츠 비중이 높아 자연 후기처럼 보이기 어렵습니다.');
  }
  if (commentManipulation) {
    score = Math.min(score, 59);
    riskFlags.push('댓글 조작 의심');
    reasons.push('댓글 반응이 반복적이라 실제 소통 품질을 다시 확인하는 편이 좋습니다.');
  }
  if (breakdown.searchVisibility >= 13) reasons.push('블로그명과 최근 글 제목이 검색 결과에서 찾기 쉬운 편입니다.');
  else reasons.push('검색에서 바로 확인되는 신호가 약해 노출 효과를 보수적으로 봐야 합니다.');
  if (breakdown.contentQuality >= 10) reasons.push('최근 글의 주제와 본문 구성이 비교적 일관적입니다.');
  else reasons.push('주제 흐름이 흩어져 있어 캠페인 메시지가 묻힐 수 있습니다.');
  if (adRatio < 45) reasons.push('일상 글 비중이 있어 광고 피로도가 낮은 편입니다.');
  else reasons.push('협찬 표현과 외부 링크가 많아 광고성 인상이 강할 수 있습니다.');
  const finalScore = Math.max(0, Math.min(100, score));
  const grade = gradeFromScore(finalScore);
  return {
    id: `result_${Date.now()}_${seed}`,
    url,
    mode,
    score: finalScore,
    grade,
    decision: decisionFromGrade(grade),
    adRatio,
    recentActivity: daysSincePost <= 7 ? '매우 활발' : daysSincePost <= 30 ? '활발' : daysSincePost <= 60 ? '주의' : '비활성',
    category,
    riskFlags,
    reasons: reasons.slice(0, 4),
    breakdown,
    recentPosts: Array.from({ length: Math.min(5, postsToAnalyze) }, (_, index) => ({
      title: `${category} ${index + 1}번째 후기와 추천 포인트`,
      adSignals: index % 2 === 0 ? ['제공', '예약 링크'] : ['자연 후기'],
      comments: 3 + ((seed + index) % 18),
    })),
  };
}

function createJob(userId, urls, mode = 'quick') {
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
  queue.push({ jobId, userId, urls: uniqueUrls, mode });
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
      const result = analyzeBlog(url, task.mode);
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
  if (failedAll && !finalJob.credit_refunded) {
    addCredits(task.userId, finalJob.credit_cost, 'analysis_refund', task.jobId);
    db.prepare('UPDATE analysis_jobs SET credit_refunded = 1 WHERE id = ?').run(task.jobId);
  }
  db.prepare('UPDATE analysis_jobs SET status = ?, completed_at = ? WHERE id = ?')
    .run(failedAll ? 'failed' : 'completed', nowIso(), task.jobId);
}

function mapResult(row) {
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
    breakdown: JSON.parse(row.breakdown),
    recentPosts: JSON.parse(row.recent_posts),
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

function oauthRedirect(res, provider, authUrl, devProfile) {
  if (authUrl) return res.redirect(authUrl);
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
  const state = storeOAuthState('naver');
  const hasKeys = process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET;
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
  const state = storeOAuthState('google');
  const hasKeys = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET;
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
    res.status(202).json(createJob(req.user.id, [url], 'quick'));
  } catch (error) {
    res.status(error.status || 500).json(error.payload || { message: error.message });
  }
});

app.post('/api/analyze/bulk', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const pastedUrls = extractUrlsFromText(req.body.urls || '');
    const fileUrls = req.file ? await extractUrlsFromWorkbook(req.file.buffer) : [];
    const urls = [...new Set([...pastedUrls, ...fileUrls])];
    if (urls.length === 0) return res.status(400).json({ message: '분석할 네이버 블로그 URL을 찾지 못했습니다.' });
    res.status(202).json(createJob(req.user.id, urls, 'quick'));
  } catch (error) {
    res.status(error.status || 500).json(error.payload || { message: error.message });
  }
});

app.post('/api/analyze/deep', requireAuth, (req, res) => {
  try {
    const urls = Array.isArray(req.body.urls) ? req.body.urls : [];
    if (urls.length === 0) return res.status(400).json({ message: '정밀 분석할 URL을 선택해주세요.' });
    res.status(202).json(createJob(req.user.id, urls, 'deep'));
  } catch (error) {
    res.status(error.status || 500).json(error.payload || { message: error.message });
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
  const header = ['URL', 'Score', 'Grade', 'Decision', 'AdRatio', 'Category', 'Reasons'];
  const csvRows = results.map((item) => [
    item.url,
    item.score,
    item.grade,
    item.decision,
    `${item.adRatio}%`,
    item.category,
    item.reasons.join(' / '),
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
  const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
  if (!payment) return res.status(404).json({ message: '결제를 찾을 수 없습니다.' });
  if (payment.secret && payment.secret !== secret) return res.status(403).json({ message: '웹훅 secret이 일치하지 않습니다.' });
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
