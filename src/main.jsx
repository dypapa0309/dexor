import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Filter,
  LogOut,
  Upload,
  Wallet,
} from 'lucide-react';
import './styles.css';

const API = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const gradeLabels = { S: '바로 선정', A: '선정 가능', B: '보류', C: '제외 권장', D: '사용 금지' };
const gradeOrder = { S: 0, A: 1, B: 2, C: 3, D: 4 };

function App() {
  const [me, setMe] = useState({ user: null, credits: null });
  const [dashboard, setDashboard] = useState(null);
  const [packages, setPackages] = useState([]);
  const [payments, setPayments] = useState([]);
  const [bulkText, setBulkText] = useState('');
  const [file, setFile] = useState(null);
  const [job, setJob] = useState(null);
  const [results, setResults] = useState([]);
  const [onlySA, setOnlySA] = useState(false);
  const [hideCD, setHideCD] = useState(false);
  const [selected, setSelected] = useState(null);
  const [billingOpen, setBillingOpen] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState('credits_100');
  const [pendingPayment, setPendingPayment] = useState(null);
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
      const nextJob = await apiJson(`${API}/jobs/${job.id}`);
      setJob(nextJob);
      const payload = await apiJson(`${API}/results/${job.id}`);
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
    const payload = await apiJson(`${API}/me`).catch(() => ({ user: null, credits: null }));
    setMe(payload);
    return payload;
  }

  async function refreshDashboard() {
    const payload = await apiJson(`${API}/dashboard`).catch(() => null);
    setDashboard(payload);
  }

  async function refreshBilling() {
    const packagePayload = await apiJson(`${API}/billing/packages`).catch(() => ({ packages: [] }));
    const paymentPayload = await apiJson(`${API}/billing/payments`).catch(() => ({ payments: [] }));
    setPackages(packagePayload.packages);
    setPayments(paymentPayload.payments);
    setPendingPayment(paymentPayload.payments.find((payment) => payment.status === 'waiting_for_deposit') || null);
  }

  async function logout() {
    await apiJson(`${API}/auth/logout`, { method: 'POST' });
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
      if (file) form.append('file', file);
      const nextJob = await apiJson(`${API}/analyze/bulk`, { method: 'POST', body: form });
      setResults([]);
      setJob(nextJob);
      await refreshMe();
    } catch (err) {
      handleAnalysisError(err);
    } finally {
      setBusy(false);
    }
  }

  async function startDeep() {
    const urls = filteredResults.filter((item) => ['S', 'A'].includes(item.grade)).map((item) => item.url);
    if (urls.length === 0) {
      setError('정밀 분석할 S/A 등급 블로그가 없습니다.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const nextJob = await apiJson(`${API}/analyze/deep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
      setResults([]);
      setJob(nextJob);
      await refreshMe();
    } catch (err) {
      handleAnalysisError(err);
    } finally {
      setBusy(false);
    }
  }

  async function createVirtualAccount() {
    setBusy(true);
    setError('');
    try {
      const payload = await apiJson(`${API}/billing/checkout/virtual-account`, {
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
    const payload = await apiJson(`${API}/billing/toss/success`, {
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
      await apiJson(`${API}/webhooks/toss/deposit`, {
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

  const progress = job && job.total ? Math.round((job.completed / job.total) * 100) : 0;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <b>DEXOR</b>
          <span>JASAIN 프로그램</span>
        </div>
        <nav className="side-nav">
          <span className="side-link active">분석</span>
          <span className="side-link">결과</span>
          <span className="side-link">결제</span>
        </nav>
      </aside>

      <section className="app-content">
        <header className="topbar">
          <div>
            <h1>분석</h1>
            <p>{me.user ? `${me.user.email} · DEXOR by JASAIN` : 'DEXOR by JASAIN'}</p>
          </div>
        {me.user ? (
          <nav>
            <span className="credit-pill"><Wallet size={16} /> {me.credits?.remaining ?? 0} 크레딧</span>
            <button onClick={() => setBillingOpen(true)}>충전</button>
            <button onClick={logout}><LogOut size={16} /> 로그아웃</button>
          </nav>
        ) : null}
      </header>

      <section className="headline">
        <div>
          <h1>네이버 블로그 선정, 분석부터 다운로드까지 한 번에</h1>
          <p>URL을 업로드하면 광고 위험도, 활동성, 등급 판단을 자동으로 정리해 선정 후보만 빠르게 남깁니다.</p>
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
      ) : (
        <section className="workspace">
          <div className="input-pane">
            <div className="section-title">
              <h2>분석</h2>
            </div>

            <div className="input-block">
              <label>블로그 URL</label>
              <textarea value={bulkText} onChange={(event) => setBulkText(event.target.value)} placeholder="네이버 블로그 URL을 하나 이상 붙여넣으세요." />
              <label className="file-drop">
                <FileSpreadsheet size={22} />
                <span>{file ? file.name : '엑셀 업로드'}</span>
                <input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => setFile(event.target.files?.[0] || null)} />
              </label>
              <p className="cost">빠른 분석: URL당 1크레딧</p>
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
                <div><b>{job.mode === 'deep' ? '정밀 분석' : '빠른 분석'}</b><span>{job.completed}/{job.total}</span></div>
                <progress value={progress} max="100" />
                <small>{job.creditCost}크레딧 차감</small>
              </div>
            )}
          </div>

          <div className="result-pane">
            <div className="section-title">
              <h2>결과</h2>
              <div className="actions">
                <button onClick={() => setOnlySA((value) => !value)} className={onlySA ? 'active' : ''}><Filter size={16} /> S/A</button>
                <button onClick={() => setHideCD((value) => !value)} className={hideCD ? 'active' : ''}>C/D 숨김</button>
                <button onClick={startDeep} disabled={!results.length || busy}><CheckCircle2 size={16} /> 정밀 분석</button>
                <a className="download" href={`${API}/export${job ? `?jobId=${job.id}` : ''}`}><Download size={16} /> 다운로드</a>
              </div>
            </div>
            <GradeStrip summary={summary} />
            <ResultsTable rows={filteredResults} onOpen={setSelected} />
          </div>
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
        <a className="primary" href={`${API}/auth/naver/start`}>네이버로 시작</a>
        <a href={`${API}/auth/google/start`}>구글로 시작</a>
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

function ResultsTable({ rows, onOpen }) {
  if (!rows.length) return <div className="empty">분석 결과가 여기에 표시됩니다.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>URL</th>
            <th>점수</th>
            <th>등급</th>
            <th>판단</th>
            <th>광고 비율</th>
            <th>이유</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.id} onClick={() => onOpen(item)}>
              <td className="url">{item.url}</td>
              <td>{item.score}</td>
              <td><span className="badge">{item.grade}</span></td>
              <td>{item.decision}</td>
              <td>{item.adRatio}%</td>
              <td>{item.reasons[0]}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
        <div className="package-grid">
          {packages.map((item) => (
            <button key={item.id} className={selectedPackage === item.id ? 'package selected' : 'package'} onClick={() => onSelect(item.id)}>
              <b>{item.name}</b>
              <span>{item.amount.toLocaleString()}원</span>
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
            {activePayment.status !== 'paid' && <button onClick={onDeposit} disabled={busy}>테스트 입금 완료 처리</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function DetailModal({ result, onClose }) {
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
          {Object.entries(result.breakdown).map(([key, value]) => (
            <div key={key}><span>{scoreLabel(key)}</span><b>{value}</b><progress value={value} max={key === 'categoryFit' ? 10 : key === 'responsiveness' || key === 'contentQuality' ? 15 : 20} /></div>
          ))}
        </div>
        <div className="detail-grid">
          <section>
            <h3>판단 이유</h3>
            <ul>{result.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            {result.riskFlags.length > 0 && <p className="risk">위험 플래그: {result.riskFlags.join(', ')}</p>}
          </section>
          <section>
            <h3>최근 글 미리보기</h3>
            {result.recentPosts.map((post) => (
              <article key={post.title}>
                <b>{post.title}</b>
                <span>{post.adSignals.join(', ')} · 댓글 {post.comments}</span>
              </article>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

function scoreLabel(key) {
  return {
    activity: '활동성',
    responsiveness: '반응성',
    contentQuality: '콘텐츠 품질',
    adRisk: '광고 위험도',
    searchVisibility: '검색 노출',
    categoryFit: '카테고리 적합',
  }[key];
}

createRoot(document.getElementById('root')).render(<App />);
