import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Filter,
  FlaskConical,
  HelpCircle,
  LogOut,
  Upload,
  Wallet,
} from 'lucide-react';
import './styles.css';

const API = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const API_BASE = `${API}/api`;
const gradeLabels = { S: '바로 섭외 추천', A: '섭외 가능', B: '조건부 섭외', C: '우선순위 낮음', D: '섭외 비추천' };
const gradeOrder = { S: 0, A: 1, B: 2, C: 3, D: 4 };
const industryOptions = [
  { value: 'auto', label: '자동' },
  { value: 'food', label: '맛집' },
  { value: 'beauty', label: '뷰티' },
  { value: 'travel', label: '여행' },
  { value: 'living', label: '리빙' },
  { value: 'parenting', label: '육아' },
  { value: 'it', label: 'IT' },
  { value: 'fashion', label: '패션' },
  { value: 'pet', label: '반려동물' },
];

function parseLegacyIndexInput(text = '') {
  return String(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((acc, line) => {
      const [rawUrl, rawIndex] = line.split(/[,\t]/).map((item) => item?.trim());
      const blogId = rawUrl?.match(/blog\.naver\.com\/([a-zA-Z0-9._-]+)/i)?.[1] || rawUrl;
      if (blogId && rawIndex) acc[blogId] = rawIndex;
      return acc;
    }, {});
}

function App() {
  const initialPage = new URLSearchParams(window.location.search).get('page');
  const [page, setPage] = useState(['analysis', 'results', 'test', 'billing'].includes(initialPage) ? initialPage : 'analysis');
  const [me, setMe] = useState({ user: null, credits: null });
  const [dashboard, setDashboard] = useState(null);
  const [packages, setPackages] = useState([]);
  const [payments, setPayments] = useState([]);
  const [bulkText, setBulkText] = useState('');
  const [industry, setIndustry] = useState('auto');
  const [keyword, setKeyword] = useState('');
  const [file, setFile] = useState(null);
  const [job, setJob] = useState(null);
  const [results, setResults] = useState([]);
  const [onlySA, setOnlySA] = useState(false);
  const [hideCD, setHideCD] = useState(false);
  const [selected, setSelected] = useState(null);
  const [logicOpen, setLogicOpen] = useState(false);
  const [billingOpen, setBillingOpen] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState('credits_20');
  const [pendingPayment, setPendingPayment] = useState(null);
  const [testUrls, setTestUrls] = useState('');
  const [testLegacyIndexes, setTestLegacyIndexes] = useState('');
  const [testResults, setTestResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    refreshMe();
  }, []);

  useEffect(() => {
    if (!me.user) return;
    refreshDashboard();
    refreshBilling();
  }, [me.user?.id]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paymentKey = params.get('paymentKey');
    const orderId = params.get('orderId');
    const amount = params.get('amount');
    if (paymentKey && orderId && amount && me.user) {
      confirmTossPayment({ paymentKey, orderId, amount });
      window.history.replaceState({}, '', '/');
    }
  }, [me.user?.id]);

  useEffect(() => {
    if (!job || job.status === 'completed' || job.status === 'failed') return;
    const timer = setInterval(async () => {
      const nextJob = await apiJson(`${API_BASE}/jobs/${job.id}`);
      setJob(nextJob);
      const payload = await apiJson(`${API_BASE}/results/${job.id}`);
      setResults(payload.results);
      if (nextJob.status === 'completed' || nextJob.status === 'failed') {
        await refreshMe();
        await refreshDashboard();
        clearInterval(timer);
      }
    }, 500);
    return () => clearInterval(timer);
  }, [job]);

  const filteredResults = useMemo(() => {
    return results
      .filter((item) => {
        if (onlySA && !['S', 'A'].includes(item.grade)) return false;
        if (hideCD && ['C', 'D'].includes(item.grade)) return false;
        return true;
      })
      .sort((a, b) => {
        const gradeDiff = gradeOrder[a.grade] - gradeOrder[b.grade];
        if (gradeDiff !== 0) return gradeDiff;
        return b.score - a.score;
      });
  }, [results, onlySA, hideCD]);

  const summary = useMemo(() => {
    const counts = { S: 0, A: 0, B: 0, C: 0, D: 0 };
    results.forEach((item) => counts[item.grade] += 1);
    return counts;
  }, [results]);
  const pastedUrlCount = useMemo(() => {
    const matches = bulkText.match(/(?:https?:\/\/)?(?:m\.)?blog\.naver\.com\/[^\s"'<>),]+/gi) || [];
    return new Set(matches.map((url) => url.trim())).size;
  }, [bulkText]);
  const estimatedQuickCost = Math.max(pastedUrlCount, file ? 1 : 0);

  async function apiJson(url, options = {}) {
    const res = await fetch(url, { credentials: 'include', ...options });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = payload.message || '요청을 처리하지 못했습니다.';
      const nextError = new Error(message);
      nextError.status = res.status;
      nextError.payload = payload;
      throw nextError;
    }
    return payload;
  }

  async function refreshMe() {
    const payload = await apiJson(`${API_BASE}/me`).catch(() => ({ user: null, credits: null }));
    setMe(payload);
    return payload;
  }

  async function refreshDashboard() {
    const payload = await apiJson(`${API_BASE}/dashboard`).catch(() => null);
    setDashboard(payload);
  }

  async function refreshBilling() {
    const packagePayload = await apiJson(`${API_BASE}/billing/packages`).catch(() => ({ packages: [] }));
    const paymentPayload = await apiJson(`${API_BASE}/billing/payments`).catch(() => ({ payments: [] }));
    setPackages(packagePayload.packages);
    setPayments(paymentPayload.payments);
    setPendingPayment(paymentPayload.payments.find((payment) => payment.status === 'waiting_for_deposit') || null);
  }

  async function logout() {
    await apiJson(`${API_BASE}/auth/logout`, { method: 'POST' });
    setMe({ user: null, credits: null });
    setDashboard(null);
    setResults([]);
    setJob(null);
  }

  function handleAnalysisError(err) {
    setError(err.message);
    if (err.status === 402) setBillingOpen(true);
  }

  async function startBulk() {
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('urls', bulkText);
      form.append('industry', industry);
      form.append('keyword', keyword);
      if (file) form.append('file', file);
      const nextJob = await apiJson(`${API_BASE}/analyze/bulk`, { method: 'POST', body: form });
      setResults([]);
      setJob(nextJob);
      setPage('results');
      await refreshMe();
    } catch (err) {
      handleAnalysisError(err);
    } finally {
      setBusy(false);
    }
  }

  async function startDeep() {
    const selectedRows = filteredResults.filter((item) => ['S', 'A', 'B'].includes(item.grade));
    const urls = selectedRows.map((item) => item.url);
    if (urls.length === 0) {
      setError('정밀 분석할 S/A/B 등급 블로그가 없습니다.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const nextJob = await apiJson(`${API_BASE}/analyze/deep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls,
          industry,
          keyword,
          dailyVisitorOverrides: Object.fromEntries(
            selectedRows
              .filter((item) => item.dailyVisitorSignal?.status === 'measured')
              .map((item) => [item.url, item.dailyVisitorSignal.estimatedAverage]),
          ),
        }),
      });
      setResults([]);
      setJob(nextJob);
      setPage('results');
      await refreshMe();
    } catch (err) {
      handleAnalysisError(err);
    } finally {
      setBusy(false);
    }
  }

  async function startStrengthenedTest() {
    setBusy(true);
    setError('');
    try {
      const payload = await apiJson(`${API_BASE}/analyze/test-strengthened`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: testUrls,
          industry,
          keyword,
          legacyIndexes: parseLegacyIndexInput(testLegacyIndexes),
        }),
      });
      setTestResults(payload.results);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function createVirtualAccount() {
    setBusy(true);
    setError('');
    try {
      const payload = await apiJson(`${API_BASE}/billing/checkout/virtual-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: selectedPackage }),
      });
      if (payload.toss.clientKey === 'test_ck_dev_placeholder') {
        const confirmed = await confirmTossPayment({
          paymentKey: `dev_payment_${payload.payment.orderId}`,
          orderId: payload.payment.orderId,
          amount: payload.payment.amount,
        });
        setPendingPayment(confirmed.payment);
      } else {
        setPendingPayment(payload.payment);
      }
      await refreshBilling();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmTossPayment({ paymentKey, orderId, amount }) {
    const payload = await apiJson(`${API_BASE}/billing/toss/success`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentKey, orderId, amount }),
    });
    setPendingPayment(payload.payment);
    setMe((prev) => ({ ...prev, credits: payload.credits }));
    await refreshBilling();
    return payload;
  }

  async function simulateDeposit() {
    if (!pendingPayment) return;
    setBusy(true);
    setError('');
    try {
      const payment = payments.find((item) => item.orderId === pendingPayment.orderId) || pendingPayment;
      await apiJson(`${API_BASE}/webhooks/toss/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: payment.orderId,
          status: 'DONE',
          secret: `dev_secret_${payment.orderId}`,
        }),
      });
      await refreshMe();
      await refreshBilling();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const finishedCount = job ? (job.completed || 0) + (job.failed || 0) : 0;
  const progress = job && job.total ? Math.round((finishedCount / job.total) * 100) : 0;
  const pageTitle = {
    analysis: '분석',
    results: '결과',
    test: '테스트',
    billing: '결제',
  }[page];

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <b>DEXOR</b>
          <span>JASAIN 프로그램</span>
        </div>
        <nav className="side-nav">
          <button className={page === 'analysis' ? 'side-link active' : 'side-link'} onClick={() => setPage('analysis')}>분석</button>
          <button className={page === 'results' ? 'side-link active' : 'side-link'} onClick={() => setPage('results')}>결과</button>
          <button className={page === 'test' ? 'side-link active' : 'side-link'} onClick={() => setPage('test')}>테스트</button>
          <button className={page === 'billing' ? 'side-link active' : 'side-link'} onClick={() => setPage('billing')}>결제</button>
        </nav>
      </aside>

      <section className="app-content">
        <header className="topbar">
          <div>
            <h1>{pageTitle}</h1>
            <p>{me.user ? `${me.user.email} · DEXOR by JASAIN` : 'DEXOR by JASAIN'}</p>
          </div>
        {me.user ? (
          <nav>
            <span className="credit-pill"><Wallet size={16} /> {me.credits?.remaining ?? 0} 크레딧</span>
            <button onClick={() => setPage('billing')}>충전</button>
            <button onClick={logout}><LogOut size={16} /> 로그아웃</button>
          </nav>
        ) : null}
      </header>

      <section className="headline">
        <div>
          <h1>캠페인 글이 노출될 블로그를 먼저 고릅니다</h1>
          <p>업종과 핵심 키워드를 기준으로 블로그의 주제 신뢰도, 문서 적합도, 키워드 경쟁도를 추정합니다.</p>
        </div>
        {me.user ? (
          <div className="summary-bar">
            <SummaryItem label="크레딧" value={me.credits?.remaining ?? 0} />
            <SummaryItem label="분석 수" value={dashboard?.analysisCount ?? 0} />
            <SummaryItem label="선정 후보" value={summary.S + summary.A} />
          </div>
        ) : null}
      </section>

      {!me.user ? (
        <LoginPanel />
      ) : page === 'analysis' ? (
        <section className="workspace">
          <div className="input-pane">
            <div className="section-title">
              <h2>분석</h2>
            </div>

            <div className="input-block">
              <label>업종 범위</label>
              <select value={industry} onChange={(event) => setIndustry(event.target.value)}>
                {industryOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              <label>세부 키워드</label>
              <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="비워두면 넓게 분석" />
              <label>블로그 URL</label>
              <textarea value={bulkText} onChange={(event) => setBulkText(event.target.value)} placeholder="네이버 블로그 URL을 하나 이상 붙여넣으세요. URL 옆에 일방문자수를 함께 넣으면 랭크 기준에 반영됩니다." />
              <label className="file-drop">
                <FileSpreadsheet size={22} />
                <span>{file ? file.name : '엑셀 업로드 · URL/일방문자수 컬럼 지원'}</span>
                <input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => setFile(event.target.files?.[0] || null)} />
              </label>
              <p className="cost">
                빠른 분석: URL당 1크레딧 · {file
                  ? `붙여넣기 ${pastedUrlCount}개 + 파일 URL은 분석 시작 후 계산`
                  : `예상 차감 ${estimatedQuickCost}크레딧`}
              </p>
              <button className="primary full" onClick={startBulk} disabled={busy}><Upload size={18} /> 분석 시작</button>
            </div>

            {error && (
              <div className="notice">
                <b>{error}</b>
                <button onClick={() => setBillingOpen(true)}>크레딧 충전</button>
              </div>
            )}

            {job && (
              <div className="job-box">
                <div><b>{job.mode === 'deep' ? '정밀 분석' : '빠른 분석'}</b><span>{finishedCount}/{job.total}</span></div>
                <progress value={progress} max="100" />
                <small>{job.creditCost}크레딧 차감{job.failed ? ` · 실패 ${job.failed}건 환불` : ''}</small>
              </div>
            )}
          </div>

          <div className="result-pane">
            <ResultsPanel
              summary={summary}
              rows={filteredResults}
              onlySA={onlySA}
              hideCD={hideCD}
              onToggleSA={() => setOnlySA((value) => !value)}
              onToggleCD={() => setHideCD((value) => !value)}
              onDeep={startDeep}
              onOpen={setSelected}
              onHelp={() => setLogicOpen(true)}
              busy={busy}
              job={job}
              compact
            />
          </div>
        </section>
      ) : page === 'results' ? (
        <section className="page-workspace">
          <div className="result-pane">
            <ResultsPanel
              summary={summary}
              rows={filteredResults}
              onlySA={onlySA}
              hideCD={hideCD}
              onToggleSA={() => setOnlySA((value) => !value)}
              onToggleCD={() => setHideCD((value) => !value)}
              onDeep={startDeep}
              onOpen={setSelected}
              onHelp={() => setLogicOpen(true)}
              busy={busy}
              job={job}
              onAnalyze={() => setPage('analysis')}
            />
          </div>
        </section>
      ) : page === 'test' ? (
        <StrengthTestPage
          industry={industry}
          keyword={keyword}
          testUrls={testUrls}
          legacyIndexes={testLegacyIndexes}
          results={testResults}
          busy={busy}
          onIndustry={setIndustry}
          onKeyword={setKeyword}
          onUrls={setTestUrls}
          onLegacyIndexes={setTestLegacyIndexes}
          onRun={startStrengthenedTest}
        />
      ) : (
        <section className="page-workspace">
          <BillingView
            packages={packages}
            selectedPackage={selectedPackage}
            onSelect={setSelectedPackage}
            onCreate={createVirtualAccount}
            onDeposit={simulateDeposit}
            busy={busy}
            payment={pendingPayment}
            payments={payments}
          />
        </section>
      )}
      </section>

      {billingOpen && (
        <BillingPanel
          packages={packages}
          selectedPackage={selectedPackage}
          onSelect={setSelectedPackage}
          onClose={() => setBillingOpen(false)}
          onCreate={createVirtualAccount}
          onDeposit={simulateDeposit}
          busy={busy}
          payment={pendingPayment}
          payments={payments}
        />
      )}
      {selected && <DetailModal result={selected} onClose={() => setSelected(null)} />}
      {logicOpen && <AnalysisLogicModal onClose={() => setLogicOpen(false)} />}
    </main>
  );
}

function LoginPanel() {
  return (
    <section className="login-panel">
      <div>
        <h2>로그인 후 분석을 시작하세요.</h2>
        <p>크레딧 잔액, 결제 상태, 분석 결과를 계정 단위로 안전하게 관리합니다.</p>
      </div>
      <div className="login-actions">
        <a className="primary" href={`${API_BASE}/auth/naver/start`}>네이버로 시작</a>
        <a href={`${API_BASE}/auth/google/start`}>구글로 시작</a>
      </div>
    </section>
  );
}

function SummaryItem({ label, value }) {
  return <div><span>{label}</span><b>{value}</b></div>;
}

function GradeStrip({ summary }) {
  return (
    <div className="grade-strip">
      {Object.entries(summary).map(([grade, count]) => (
        <div key={grade} className="grade"><b>{grade}</b><span>{count}</span></div>
      ))}
    </div>
  );
}

function ResultsPanel({
  summary,
  rows,
  onlySA,
  hideCD,
  onToggleSA,
  onToggleCD,
  onDeep,
  onOpen,
  onHelp,
  busy,
  job,
  onAnalyze,
  compact = false,
}) {
  return (
    <>
      <div className="section-title">
        <div>
          <div className="title-with-help">
            <h2>결과</h2>
            <button className="icon-help" type="button" onClick={onHelp} aria-label="분석 로직 보기" title="분석 로직 보기">
              <HelpCircle size={17} />
            </button>
          </div>
          {!compact && <p>노출가능성 점수가 높은 후보부터 검토할 수 있습니다.</p>}
        </div>
        <div className="actions">
          <button onClick={onToggleSA} className={onlySA ? 'active' : ''}><Filter size={16} /> S/A</button>
          <button onClick={onToggleCD} className={hideCD ? 'active' : ''}>C/D 숨김</button>
          <button onClick={onDeep} disabled={!rows.length || busy}><CheckCircle2 size={16} /> S/A/B 정밀 분석</button>
          <a className="download" href={`${API_BASE}/export${job ? `?jobId=${job.id}` : ''}`}><Download size={16} /> 다운로드</a>
        </div>
      </div>
      <GradeStrip summary={summary} />
      <ResultsTable rows={rows} onOpen={onOpen} onAnalyze={onAnalyze} />
    </>
  );
}

function ResultsTable({ rows, onOpen, onAnalyze }) {
  if (!rows.length) {
    return (
      <div className="empty">
        <span>분석을 시작하면 결과가 여기에 표시됩니다.</span>
        {onAnalyze && <button onClick={onAnalyze}>분석하러 가기</button>}
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>URL</th>
            <th>노출가능성</th>
            <th>등급</th>
            <th>주제 적합도</th>
            <th>키워드 경쟁도</th>
            <th>최근 활동성</th>
            <th>추천 캠페인</th>
            <th>선정 이유</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.id} onClick={() => onOpen(item)}>
              <td className="url">{item.url}</td>
              <td>{item.exposureScore ?? item.score}</td>
              <td><span className="badge">{item.grade}</span></td>
              <td>{item.topicFit ?? '-'}</td>
              <td>{item.keywordCompetition ?? '-'}</td>
              <td>{item.recentActivity}</td>
              <td>{item.recommendation || item.decision}</td>
              <td>{item.reasons[0]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StrengthTestPage({
  industry,
  keyword,
  testUrls,
  legacyIndexes,
  results,
  busy,
  onIndustry,
  onKeyword,
  onUrls,
  onLegacyIndexes,
  onRun,
}) {
  const downgradedCount = results.filter((item) => item.originalGrade !== item.strengthenedGrade).length;
  return (
    <section className="test-workspace">
      <div className="test-controls">
        <div className="section-title">
          <div>
            <h2>강화 로직 테스트</h2>
            <p>크레딧 차감 없이 강화 등급, 데이터 신뢰도, 기존 지수 충돌을 비교합니다.</p>
          </div>
        </div>
        <div className="input-block">
          <label>업종 범위</label>
          <select value={industry} onChange={(event) => onIndustry(event.target.value)}>
            {industryOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <label>세부 키워드</label>
          <input value={keyword} onChange={(event) => onKeyword(event.target.value)} placeholder="비워두면 넓게 분석" />
          <label>테스트 URL</label>
          <textarea value={testUrls} onChange={(event) => onUrls(event.target.value)} placeholder="네이버 블로그 URL을 줄바꿈으로 붙여넣으세요. URL, 일방문자수 형식도 가능합니다." />
          <label>기존 지수 매칭</label>
          <textarea
            className="compact-textarea"
            value={legacyIndexes}
            onChange={(event) => onLegacyIndexes(event.target.value)}
            placeholder="blogId 또는 URL, 기존지수&#10;example_blog, 초급"
          />
          <button className="primary full" onClick={onRun} disabled={busy}><FlaskConical size={18} /> 강화 로직 테스트</button>
        </div>
      </div>

      <div className="test-results">
        <div className="section-title">
          <div>
            <h2>비교 결과</h2>
            <p>{results.length ? `${results.length}개 중 ${downgradedCount}개가 강화 기준에서 조정되었습니다.` : '테스트를 실행하면 비교 결과가 표시됩니다.'}</p>
          </div>
        </div>
        {results.length ? <StrengthResults rows={results} /> : <div className="empty small">테스트 결과가 없습니다.</div>}
      </div>
    </section>
  );
}

function StrengthResults({ rows }) {
  return (
    <div className="strength-list">
      {rows.map((item) => (
        <article className="strength-card" key={item.id}>
          <header>
            <div>
              <b>{item.url}</b>
              <span>{item.category} · {item.campaign?.keyword || '-'} · 기존 지수 {item.legacyIndex || '없음'}</span>
            </div>
            <div className="grade-compare">
              <span className="badge">{item.originalGrade} {item.originalScore}</span>
              <span className="arrow">→</span>
              <span className="badge strong">{item.strengthenedGrade} {item.strengthenedScore}</span>
            </div>
          </header>
          <div className="signal-grid">
            <Signal label="데이터 신뢰도" value={`${item.dataConfidence.level} ${item.dataConfidence.score}`} detail={item.dataConfidence.sourceLabel} />
            <Signal label="주제 적합도" value={item.topicFit ?? '-'} detail={`최근 글 ${item.recentPostCount ?? '-'}개`} />
            <Signal
              label="최근 5개 키워드"
              value={item.recentKeywordCheck ? `${item.recentKeywordCheck.recentFiveMatchedCount}/${item.recentKeywordCheck.recentFiveCheckedCount}` : '-'}
              detail={item.recentKeywordCheck?.label || '세부키워드 확인'}
            />
            <Signal label="문서 적합도" value={item.diaFit ?? '-'} detail={`광고성 ${item.adRatio}%`} />
            <Signal
              label="일방문자수"
              value={item.dailyVisitorSignal ? `평균 ${item.dailyVisitorSignal.estimatedAverage}` : '미확인'}
              detail={item.dailyVisitorSignal?.label || '실측 미확인'}
            />
            <Signal label="상위노출 검증" value={item.searchValidation.label} detail="정밀 단계에서 검증 예정" />
          </div>
          <div className="flag-row">
            {item.verificationFlags.map((flag) => <span key={flag}>{flag}</span>)}
          </div>
        </article>
      ))}
    </div>
  );
}

function Signal({ label, value, detail }) {
  return (
    <div className="signal">
      <span>{label}</span>
      <b>{value}</b>
      <small>{detail}</small>
    </div>
  );
}

function BillingView({ packages, selectedPackage, onSelect, onCreate, onDeposit, busy, payment, payments }) {
  const activePayment = payment || payments.find((item) => item.status === 'waiting_for_deposit');
  const packageNames = Object.fromEntries(packages.map((item) => [item.id, item.name]));
  return (
    <div className="billing-page">
      <div className="section-title">
        <div>
          <h2>크레딧 충전</h2>
          <p>분석에 필요한 크레딧을 가상계좌로 충전합니다.</p>
        </div>
      </div>
      <BillingContent
        packages={packages}
        selectedPackage={selectedPackage}
        onSelect={onSelect}
        onCreate={onCreate}
        onDeposit={onDeposit}
        busy={busy}
        activePayment={activePayment}
      />
      <section className="payment-history">
        <h3>결제 내역</h3>
        {payments.length === 0 ? (
          <div className="empty small">아직 결제 내역이 없습니다.</div>
        ) : (
          <div className="payment-list">
            {payments.map((item) => (
              <div className="payment-row" key={item.orderId}>
                <div>
                  <b>{packageNames[item.packageId] || '크레딧 상품'}</b>
                  <span>{item.orderId}</span>
                </div>
                <div>
                  <b>{paymentStatus(item.status)}</b>
                  <span>{item.credits?.toLocaleString()}크레딧 · {item.amount?.toLocaleString()}원</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function BillingPanel({ packages, selectedPackage, onSelect, onClose, onCreate, onDeposit, busy, payment, payments }) {
  const activePayment = payment || payments.find((item) => item.status === 'waiting_for_deposit');
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal billing" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">크레딧 충전</span>
            <h2>가상계좌로 자동 충전</h2>
          </div>
          <button onClick={onClose}>닫기</button>
        </div>
        <BillingContent
          packages={packages}
          selectedPackage={selectedPackage}
          onSelect={onSelect}
          onCreate={onCreate}
          onDeposit={onDeposit}
          busy={busy}
          activePayment={activePayment}
        />
      </div>
    </div>
  );
}

function BillingContent({ packages, selectedPackage, onSelect, onCreate, onDeposit, busy, activePayment }) {
  return (
    <>
      <div className="package-grid">
        {packages.map((item) => (
          <button key={item.id} className={selectedPackage === item.id ? 'package selected' : 'package'} onClick={() => onSelect(item.id)}>
            <b>{item.name}</b>
            <span>{item.amount.toLocaleString()}원</span>
            <small>빠른 {item.credits.toLocaleString()}개 · 정밀 {Math.floor(item.credits / 3).toLocaleString()}개</small>
          </button>
        ))}
      </div>
      <button className="primary full" onClick={onCreate} disabled={busy}>가상계좌 발급</button>
      {activePayment && (
        <div className="payment-box">
          <b>{activePayment.status === 'paid' ? '충전 완료' : '입금 대기'}</b>
          <span>주문번호 {activePayment.orderId}</span>
          <span>{activePayment.credits?.toLocaleString()}크레딧 · {activePayment.amount?.toLocaleString()}원</span>
          {activePayment.virtualAccount && (
            <span>계좌 {activePayment.virtualAccount.bankCode || '은행'} {activePayment.virtualAccount.accountNumber}</span>
          )}
          {!import.meta.env.PROD && activePayment.status !== 'paid' && <button onClick={onDeposit} disabled={busy}>테스트 입금 완료 처리</button>}
        </div>
      )}
    </>
  );
}

function paymentStatus(status) {
  return {
    waiting_for_deposit: '입금 대기',
    paid: '충전 완료',
    failed: '결제 실패',
  }[status] || status;
}

function AnalysisLogicModal({ onClose }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal logic-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">분석 로직</span>
            <h2>결과는 이렇게 계산됩니다</h2>
          </div>
          <button onClick={onClose}>닫기</button>
        </div>
        <div className="logic-body">
          <section>
            <h3>1. 개별 포스트 직접 분석</h3>
            <p>입력 URL에 글 번호가 있으면 제목, 본문, 발행일, 이미지, 광고성 표현을 읽고 포스트 적합도를 계산합니다.</p>
          </section>
          <section>
            <h3>2. 블로그 최근 흐름 보조 분석</h3>
            <p>RSS 최근 글에서 활동성, 주제 일관성, 광고성 비율, 최근 5개·10개 게시물의 세부키워드 노출을 확인합니다.</p>
          </section>
          <section>
            <h3>3. 최종 점수 산식</h3>
            <p>개별 포스트가 있으면 포스트 적합도를 중심으로 C-Rank형 적합도, 문서 적합도, 상위권 유사도, 최근 활동성, 최근 키워드 포함률을 보조 반영합니다.</p>
            <div className="formula-box">포스트 60% + C-Rank 14% + 문서 12% + 유사도 7% + 활동성 4% + 최근 키워드 3% - 리스크 감점</div>
          </section>
          <section>
            <h3>4. 리스크 감점</h3>
            <p>최근 활동 약함, 대가성 콘텐츠 비중 높음, 최근 5개 세부키워드 없음, 최근 10개 키워드 없음, 일방문자수 기준 미달이 있으면 점수와 최대 랭크가 내려갑니다.</p>
          </section>
        </div>
      </div>
    </div>
  );
}

function DetailModal({ result, onClose }) {
  const scoreCards = [
    ['exposureScore', '노출가능성', result.exposureScore ?? result.score],
    ['postFit', '개별 포스트 적합도', result.postFit],
    ['postTopicFit', '포스트 주제 적합도', result.postTopicFit],
    ['cRankFit', 'C-Rank형 적합도', result.cRankFit],
    ['diaFit', '문서 적합도', result.diaFit],
    ['topicFit', '주제 적합도', result.topicFit],
    ['keywordCompetition', '키워드 경쟁도', result.keywordCompetition],
    ['competitorSimilarity', '상위권 유사도', result.competitorSimilarity],
  ].filter(([, , value]) => value !== null && value !== undefined);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <span className="badge">{result.grade} {gradeLabels[result.grade]}</span>
            <h2>{result.url}</h2>
          </div>
          <button onClick={onClose}>닫기</button>
        </div>
        <div className="breakdown">
          {scoreCards.map(([key, label, value]) => (
            <div key={key}><span>{label}</span><b>{value}</b><progress value={value} max="100" /></div>
          ))}
        </div>
        <div className="detail-grid">
          <section>
            <h3>판단 이유</h3>
            <ul>{result.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            {result.recentKeywordCheck && (
              <p className="risk">
                최근 세부키워드: 5개 중 {result.recentKeywordCheck.recentFiveMatchedCount}개,
                10개 중 {result.recentKeywordCheck.matchedCount}개 확인
              </p>
            )}
            {result.derivedKeywords?.length > 0 && (
              <p className="risk">보조 검토 키워드: {result.derivedKeywords.map((item) => item.keyword).join(', ')}</p>
            )}
            {result.postSignals && (
              <p className="risk">
                개별 포스트: {result.postSignals.title || result.postSignals.logNo}
                {result.postSignals.publishedAtLabel ? ` · ${result.postSignals.publishedAtLabel}` : ''}
                {` · 본문 ${result.postSignals.bodyLength?.toLocaleString?.() || result.postSignals.bodyLength || 0}자`}
              </p>
            )}
            {result.riskFlags.length > 0 && <p className="risk">위험 플래그: {result.riskFlags.join(', ')}</p>}
          </section>
          <section>
            <h3>주의 이유</h3>
            <ul>{(result.cautionReasons || []).map((reason) => <li key={reason}>{reason}</li>)}</ul>
            {result.campaign && <p className="risk">캠페인: {result.campaign.industryLabel} · {result.campaign.keyword}</p>}
            <p className="risk">
              일방문자수: {result.dailyVisitorSignal
                ? `${result.dailyVisitorSignal.label} 평균 ${result.dailyVisitorSignal.estimatedAverage}명 (${result.dailyVisitorSignal.estimatedMin}-${result.dailyVisitorSignal.estimatedMax})`
                : '실측 미확인'}
            </p>
          </section>
          <section>
            <h3>최근 글 미리보기</h3>
            {result.recentPosts.map((post) => (
              <article key={post.title}>
                <b>{post.title}</b>
                <span>{post.adSignals.join(', ')} · 댓글 {post.comments} · {post.daysAgo ?? '-'}일 전</span>
              </article>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
