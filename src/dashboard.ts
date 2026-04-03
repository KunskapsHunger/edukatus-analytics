import { Chart, registerables } from 'chart.js';
import type { StoredData, AbsenceRecord, StudentAbsenceSummary, Guardian, CourseHours, StudentCounselingData } from './types';

Chart.register(...registerables);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let data: StoredData = {
  students: [],
  grades: [],
  attendance: [],
  courses: [],
  absenceRecords: [],
  studentSummaries: [],
  periodSummaries: [],
  courseHours: [],
  counselingData: [],
  lastUpdated: null,
  sources: [],
  schoolInfo: null,
};

// Guardian data is never persisted — fetched from background in-memory cache
let guardianCache: Guardian[] = [];
let currentView = 'overview';
let expandedStudentName: string | null = null;
let selectedReportStudent: string | null = null;
const charts: Chart[] = [];

// Filter state
let filterClass = '';           // '' = all classes
let filterPeriod = 'recent';    // 'recent' | 'year' | 'ht' | 'vt' | 'prev-year' | 'prev-ht' | 'prev-vt'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ABSENCE_THRESHOLD = 15; // percentage
const DAY_NAMES = ['Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag', 'Söndag'];
const DAY_SHORT = ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'];

// Meritvärde grade points (Swedish gymnasium scale)
const MERIT_POINTS: Record<string, number> = { A: 20, B: 17.5, C: 15, D: 12.5, E: 10, F: 0 };

// EA brand chart palette: navy, blue, purple accent, warm grays
const CHART_COLORS = [
  '#384A66', '#4F6A8C', '#553876', '#ADBCD7', '#C8C1B6',
  '#1F2F45', '#8A8580', '#D7DEEC', '#E6E0D8', '#DAD2C7',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const main = (): HTMLElement => $('main');

function esc(s: string): string {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

function destroyCharts(): void {
  for (const c of charts) c.destroy();
  charts.length = 0;
}

function fmtMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

function pctColor(pct: number): string {
  if (pct >= ABSENCE_THRESHOLD) return '#c0392b';
  if (pct >= 10) return '#d4a017';
  return '#27ae60';
}

/**
 * Calculate meritvärde (utan tillägg) for a student.
 * Weighted average of grade points by course credits.
 * Excludes gymnasiearbete (pass/fail) and utökade kurser.
 * Returns { merit: number (0-20 scale), totalCredits: number } or null if no eligible grades.
 */
function calculateMerit(studentName: string): { merit: number; totalCredits: number } | null {
  const grades = data.grades.filter((g) =>
    g.studentName === studentName &&
    !g.isGymnasiearbete &&
    !g.isExtended &&
    g.value in MERIT_POINTS &&
    g.credits > 0
  );

  if (grades.length === 0) return null;

  const totalCredits = grades.reduce((sum, g) => sum + g.credits, 0);
  const weightedSum = grades.reduce((sum, g) => sum + MERIT_POINTS[g.value] * g.credits, 0);

  if (totalCredits === 0) return null;

  return {
    merit: Math.round((weightedSum / totalCredits) * 100) / 100,
    totalCredits,
  };
}

/** Format meritvärde for display: "13.11 (1850p)" */
function fmtMerit(studentName: string): string {
  const m = calculateMerit(studentName);
  if (!m) return '-';
  return `${m.merit.toFixed(2)} (${m.totalCredits}p)`;
}

function rowBgStyle(pct: number): string {
  if (pct >= ABSENCE_THRESHOLD) return 'background:rgba(192,57,43,0.06);border-left:3px solid #c0392b;';
  if (pct >= 10) return 'background:rgba(212,160,23,0.06);border-left:3px solid #d4a017;';
  return 'border-left:3px solid transparent;';
}

/** Shared light-theme chart scale defaults (EA brand) */
function darkScales(opts?: { xTitle?: string; yTitle?: string }) {
  return {
    x: {
      grid: { color: '#E6E0D8' },
      ticks: { color: '#4F6A8C', font: { family: 'Inter, system-ui, sans-serif', size: 11 } },
      ...(opts?.xTitle ? { title: { display: true, text: opts.xTitle, color: '#8A8580' } } : {}),
    },
    y: {
      grid: { color: '#E6E0D8' },
      ticks: { color: '#8A8580' },
      beginAtZero: true,
      ...(opts?.yTitle ? { title: { display: true, text: opts.yTitle, color: '#8A8580' } } : {}),
    },
  };
}

function darkTooltip() {
  return {
    backgroundColor: '#1F2F45',
    borderColor: '#384A66',
    borderWidth: 1,
    titleColor: '#ffffff',
    bodyColor: '#ADBCD7',
  };
}

// ---------------------------------------------------------------------------
// CSV Export
// ---------------------------------------------------------------------------

function exportCsv(rows: Record<string, string | number>[], filename: string): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const csvLines = [
    headers.join(';'),  // Swedish Excel uses semicolon separator
    ...rows.map(r => headers.map(h => String(r[h] ?? '')).join(';'))
  ];
  const bom = '\uFEFF';
  const blob = new Blob([bom + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Data access helpers
// ---------------------------------------------------------------------------

function loadData(): Promise<StoredData> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_ALL_DATA' }, (resp: { payload?: StoredData } | undefined) => {
      resolve(resp?.payload ?? data);
    });
  });
}

function loadGuardians(): Promise<Guardian[]> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_GUARDIANS' }, (resp: { guardians?: Guardian[] } | undefined) => {
      resolve(resp?.guardians ?? []);
    });
  });
}

/** Records grouped by student name (uses all absenceRecords) */
function recordsByStudent(): Map<string, AbsenceRecord[]> {
  const map = new Map<string, AbsenceRecord[]>();
  for (const r of data.absenceRecords) {
    const list = map.get(r.studentName) ?? [];
    list.push(r);
    map.set(r.studentName, list);
  }
  return map;
}

/** Records grouped by student name (respects filterClass) */
function filteredRecordsByStudent(): Map<string, AbsenceRecord[]> {
  const map = new Map<string, AbsenceRecord[]>();
  for (const r of filteredRecords()) {
    const list = map.get(r.studentName) ?? [];
    list.push(r);
    map.set(r.studentName, list);
  }
  return map;
}

/** Returns summaries filtered by the current filterClass and filterPeriod state */
function filteredSummaries(): readonly StudentAbsenceSummary[] {
  // Period filter: find matching PeriodSummary; fall back to studentSummaries if not found
  let base: readonly StudentAbsenceSummary[];
  if (filterPeriod) {
    const found = (data.periodSummaries ?? []).find((p) => p.period === filterPeriod);
    base = found ? found.summaries : data.studentSummaries;
  } else {
    base = data.studentSummaries;
  }

  // Class filter
  if (filterClass) {
    return base.filter((s) => s.className === filterClass);
  }
  return base;
}

/** Returns absenceRecords filtered by the current filterClass state */
function filteredRecords(): readonly AbsenceRecord[] {
  if (!filterClass) return data.absenceRecords;
  return data.absenceRecords.filter((r) => r.className === filterClass);
}

/** Sorted summaries: highest totalAbsencePercent first */
function sortedSummaries(): readonly StudentAbsenceSummary[] {
  return [...filteredSummaries()].sort((a, b) => b.totalAbsencePercent - a.totalAbsencePercent);
}

/** Only flagged summaries (>= ABSENCE_THRESHOLD) */
function flaggedSummaries(): readonly StudentAbsenceSummary[] {
  return sortedSummaries().filter((s) => s.isFlagged);
}

// ---------------------------------------------------------------------------
// Empty state helper
// ---------------------------------------------------------------------------

function renderEmpty(title: string, icon: string, text: string, hint: string): string {
  return `
    <h2 class="page-title">${title}</h2>
    <div class="empty">
      <div class="empty-icon">${icon}</div>
      <div class="empty-text">${text}</div>
      <div class="empty-hint">${hint}</div>
      <button class="btn btn-accent" id="btn-fetch-inline" style="margin-top:16px;padding:10px 24px;font-size:14px;">
        Hämta data från Progress
      </button>
    </div>
  `;
}

/** Attach click handler for inline fetch button (called after rendering an empty state) */
function attachInlineFetch(): void {
  const btn = document.getElementById('btn-fetch-inline');
  if (!btn) return;
  btn.addEventListener('click', () => triggerFetch());
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

const PERIOD_LABELS: Record<string, string> = {
  recent:      'Senaste 2 månader',
  year:        'Helår (nuvarande)',
  ht:          'HT (nuvarande)',
  vt:          'VT (nuvarande)',
  'prev-year': 'Helår (förra)',
  'prev-ht':   'HT (förra)',
  'prev-vt':   'VT (förra)',
};

function renderFilterBar(): string {
  // Unique class names from studentSummaries (not filtered, to always show all options)
  const classNames = [...new Set(data.studentSummaries.map((s) => s.className).filter(Boolean))].sort();

  // Available periods from stored periodSummaries
  const availablePeriods = (data.periodSummaries ?? []).map((p) => p.period);

  const classOptions = [
    `<option value="">Alla klasser</option>`,
    ...classNames.map((c) => `<option value="${esc(c)}"${filterClass === c ? ' selected' : ''}>${esc(c)}</option>`),
  ].join('');

  const periodOptions = Object.entries(PERIOD_LABELS)
    .filter(([key]) => key === 'recent' || availablePeriods.includes(key as any))
    .map(([key, label]) => `<option value="${key}"${filterPeriod === key ? ' selected' : ''}>${label}</option>`)
    .join('');

  const selectStyle = 'background:var(--beige-100);border:1px solid var(--border);border-radius:6px;padding:5px 10px;font-size:12px;color:var(--text-primary);font-family:var(--font)';

  return `
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:20px;padding:10px 16px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px">
      <span style="font-size:12px;color:var(--text-secondary);font-weight:600">Filter:</span>
      <select id="filter-class" style="${selectStyle}">${classOptions}</select>
      <select id="filter-period" style="${selectStyle}">${periodOptions}</select>
    </div>
  `;
}

function attachFilterListeners(): void {
  document.getElementById('filter-class')?.addEventListener('change', (e) => {
    filterClass = (e.target as HTMLSelectElement).value;
    expandedStudentName = null;
    render();
  });
  document.getElementById('filter-period')?.addEventListener('change', (e) => {
    filterPeriod = (e.target as HTMLSelectElement).value;
    expandedStudentName = null;
    render();
  });
}

// ---------------------------------------------------------------------------
// Datakvalitet card (course hours reporting rate)
// ---------------------------------------------------------------------------

function renderDatakvalitet(): string {
  const courseHours = data.courseHours ?? [];
  if (courseHours.length === 0) return '';

  // School-wide average reporting rate (weighted by total lessons)
  const totalLessons = courseHours.reduce((acc, c) => acc + c.totalLessons, 0);
  const reportedLessons = courseHours.reduce((acc, c) => acc + (c.totalLessons - c.unreportedLessons), 0);
  const schoolWideRate = totalLessons > 0
    ? Math.round((reportedLessons / totalLessons) * 1000) / 10
    : 0;

  const rateColor = schoolWideRate >= 95 ? '#27ae60' : schoolWideRate >= 80 ? '#d4a017' : '#c0392b';
  const rateBg = schoolWideRate >= 95 ? '#27ae6018' : schoolWideRate >= 80 ? '#d4a01718' : '#c0392b18';

  // Courses with < 80% reporting rate
  const lowReportingCourses = [...courseHours]
    .filter((c) => c.reportingRate < 80)
    .sort((a, b) => a.reportingRate - b.reportingRate);

  const warningRows = lowReportingCourses.slice(0, 8).map((c) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border-subtle);font-size:12px;">
      <span style="color:var(--text-secondary);flex:1">${esc(c.courseName)}</span>
      <span style="font-variant-numeric:tabular-nums;color:#c0392b;font-weight:600;margin-left:8px">${c.reportingRate}%</span>
    </div>
  `).join('');

  return `
    <div class="card" style="margin-top:20px">
      <div class="card-header">
        <span class="card-title">Datakvalitet</span>
        <span style="font-size:12px;color:var(--text-dim)">${courseHours.length} kurser</span>
      </div>
      <div style="padding:8px 0">
        <div style="
          display:inline-block;padding:10px 16px;border-radius:8px;
          background:${rateBg};border:1px solid ${rateColor}40;
          margin-bottom:12px
        ">
          <div style="font-size:24px;font-weight:700;color:${rateColor};font-variant-numeric:tabular-nums">${schoolWideRate}%</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">av lektionerna har rapporterad närvaro</div>
        </div>
        ${lowReportingCourses.length > 0 ? `
          <div style="margin-top:4px">
            <div style="font-size:12px;font-weight:600;color:#c0392b;margin-bottom:6px">
              &#9888; ${lowReportingCourses.length} kurs${lowReportingCourses.length !== 1 ? 'er' : ''} med under 80% rapportering
            </div>
            ${warningRows}
            ${lowReportingCourses.length > 8 ? `<div style="font-size:11px;color:var(--text-dim);margin-top:4px">...och ${lowReportingCourses.length - 8} till</div>` : ''}
          </div>
        ` : `
          <div style="font-size:12px;color:#27ae60">&#10003; Alla kurser rapporterar över 80%</div>
        `}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// View: Översikt (Overview)
// ---------------------------------------------------------------------------

function renderOverview(): void {
  destroyCharts();

  const summaries = sortedSummaries();
  const records = filteredRecords();

  if (summaries.length === 0) {
    main().innerHTML = renderEmpty(
      'Översikt',
      '&#128202;',
      'Ingen frånvarodata insamlad',
      'Besök frånvarosidan i Progress. Data samlas in automatiskt.'
    );
    return;
  }

  const totalStudents = summaries.length;
  const flaggedCount = summaries.filter((s) => s.isFlagged).length;
  const avgAbsencePct = summaries.length > 0
    ? Math.round(summaries.reduce((acc, s) => acc + s.totalAbsencePercent, 0) / summaries.length * 10) / 10
    : 0;

  // Total absent minutes = sum of (unexcused + excused) across all students
  const totalAbsenceMinutes = summaries.reduce((acc, s) => acc + s.unexcusedMinutes + s.excusedMinutes, 0);
  const totalAbsenceHours = Math.round(totalAbsenceMinutes / 60);

  // Absence % distribution buckets: 0-5, 5-10, 10-15, 15-20, 20-30, 30+
  const distBuckets = [0, 0, 0, 0, 0, 0];
  const distLabels = ['0–5%', '5–10%', '10–15%', '15–20%', '20–30%', '30%+'];
  for (const s of summaries) {
    const p = s.totalAbsencePercent;
    if (p < 5) distBuckets[0]++;
    else if (p < 10) distBuckets[1]++;
    else if (p < 15) distBuckets[2]++;
    else if (p < 20) distBuckets[3]++;
    else if (p < 30) distBuckets[4]++;
    else distBuckets[5]++;
  }

  // Day-of-week counts (from absenceRecords)
  const dayMinutes = Array<number>(7).fill(0);
  for (const r of records) {
    const d = r.dayOfWeek;
    if (d >= 0 && d <= 6) dayMinutes[d] += r.totalAbsenceMinutes;
  }

  // Excused vs unexcused totals from summaries
  const excusedTotal = summaries.reduce((acc, s) => acc + s.excusedMinutes, 0);
  const unexcusedTotal = summaries.reduce((acc, s) => acc + s.unexcusedMinutes, 0);

  main().innerHTML = `
    <h2 class="page-title">Översikt</h2>
    <p class="page-subtitle">Frånvaroanalys — ${totalStudents} elever</p>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">Totalt elever</div>
        <div class="stat-value">${totalStudents}</div>
        <div class="stat-sub">med frånvarodata</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Flaggade elever</div>
        <div class="stat-value" style="color:#c0392b">${flaggedCount}</div>
        <div class="stat-sub">≥ ${ABSENCE_THRESHOLD}% frånvaro</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Snittfrånvaro</div>
        <div class="stat-value" style="color:${pctColor(avgAbsencePct)}">${avgAbsencePct}%</div>
        <div class="stat-sub">bland alla elever</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total frånvaro</div>
        <div class="stat-value" style="font-size:22px">${totalAbsenceHours} h</div>
        <div class="stat-sub">${totalAbsenceMinutes} min totalt</div>
      </div>
    </div>

    <div class="card-grid">
      <div class="card">
        <div class="card-header"><span class="card-title">Frånvarofördelning bland elever</span></div>
        <div class="chart-container"><canvas id="chart-dist"></canvas></div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Frånvaro per veckodag</span></div>
        <div class="chart-container"><canvas id="chart-dow"></canvas></div>
      </div>
    </div>

    <div class="card-grid">
      <div class="card">
        <div class="card-header"><span class="card-title">Oanmäld vs anmäld frånvaro</span></div>
        <div class="chart-container" style="height:200px"><canvas id="chart-excused"></canvas></div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Sammanfattning</span></div>
        <div style="padding: 8px 0;">
          <div class="detail-item" style="padding: 8px 0; border-bottom: 1px solid var(--border-subtle);">
            <span class="detail-item-label">Oanmäld frånvaro</span>
            <span style="font-variant-numeric:tabular-nums;color:#c0392b">${fmtMinutes(unexcusedTotal)}</span>
          </div>
          <div class="detail-item" style="padding: 8px 0; border-bottom: 1px solid var(--border-subtle);">
            <span class="detail-item-label">Anmäld frånvaro</span>
            <span style="font-variant-numeric:tabular-nums;color:#27ae60">${fmtMinutes(excusedTotal)}</span>
          </div>
          <div class="detail-item" style="padding: 8px 0; border-bottom: 1px solid var(--border-subtle);">
            <span class="detail-item-label">Total frånvaro</span>
            <span style="font-variant-numeric:tabular-nums;color:var(--text-primary)">${fmtMinutes(totalAbsenceMinutes)}</span>
          </div>
          <div class="detail-item" style="padding: 8px 0;">
            <span class="detail-item-label">Andel anmäld</span>
            <span style="font-variant-numeric:tabular-nums;color:var(--text-secondary)">
              ${totalAbsenceMinutes > 0 ? Math.round((excusedTotal / totalAbsenceMinutes) * 100) : 0}%
            </span>
          </div>
        </div>
      </div>
    </div>

    ${renderDatakvalitet()}
  `;

  // Absence distribution bar chart
  const distCtx = (document.getElementById('chart-dist') as HTMLCanvasElement).getContext('2d')!;
  charts.push(new Chart(distCtx, {
    type: 'bar',
    data: {
      labels: distLabels,
      datasets: [{
        data: distBuckets,
        backgroundColor: ['#27ae6080', '#27ae6080', '#d4a01780', '#d4a01780', '#c0392b80', '#c0392b80'],
        borderColor:     ['#27ae60',   '#27ae60',   '#d4a017',   '#d4a017',   '#c0392b',   '#c0392b'],
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { ...darkTooltip(), callbacks: { label: (ctx) => `${ctx.parsed.y} elever` } },
      },
      scales: darkScales({ yTitle: 'Antal elever' }),
    },
  }));

  // Day-of-week bar chart (from absenceRecords)
  if (records.length > 0) {
    const dowCtx = (document.getElementById('chart-dow') as HTMLCanvasElement).getContext('2d')!;
    charts.push(new Chart(dowCtx, {
      type: 'bar',
      data: {
        labels: DAY_SHORT,
        datasets: [{
          data: dayMinutes.map((m) => Math.round(m / 60 * 10) / 10),
          backgroundColor: CHART_COLORS[0] + '80',
          borderColor: CHART_COLORS[0],
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { ...darkTooltip(), callbacks: { label: (ctx) => `${ctx.parsed.y} h` } } },
        scales: darkScales({ yTitle: 'Timmar' }),
      },
    }));
  }

  // Excused vs unexcused doughnut
  if (excusedTotal > 0 || unexcusedTotal > 0) {
    const excCtx = (document.getElementById('chart-excused') as HTMLCanvasElement).getContext('2d')!;
    charts.push(new Chart(excCtx, {
      type: 'doughnut',
      data: {
        labels: ['Oanmäld', 'Anmäld'],
        datasets: [{
          data: [unexcusedTotal, excusedTotal],
          backgroundColor: ['#c0392b80', '#27ae6080'],
          borderColor: ['#c0392b', '#27ae60'],
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#4F6A8C', padding: 16, font: { size: 12 } } },
          tooltip: { ...darkTooltip(), callbacks: { label: (ctx) => ` ${fmtMinutes(ctx.parsed as number)}` } },
        },
      },
    }));
  }
}

// ---------------------------------------------------------------------------
// View: Närvaro (Absence detail table)
// ---------------------------------------------------------------------------

/** Per-course + day pattern expansion for a single student */
function renderExpansion(summary: StudentAbsenceSummary, records: AbsenceRecord[]): string {
  // Per-course breakdown from absenceRecords
  const byCourse = new Map<string, { total: number; excused: number; unexcused: number; count: number }>();
  for (const r of records) {
    const entry = byCourse.get(r.courseName) ?? { total: 0, excused: 0, unexcused: 0, count: 0 };
    byCourse.set(r.courseName, {
      total: entry.total + r.totalAbsenceMinutes,
      excused: entry.excused + r.reportedMinutes,
      unexcused: entry.unexcused + r.absenceMinutes,
      count: entry.count + 1,
    });
  }

  const courseRows = [...byCourse.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([course, stats]) => `
      <div class="detail-item" style="padding:5px 0;border-bottom:1px solid var(--border-subtle);">
        <span class="detail-item-label" style="flex:1">${esc(course)}</span>
        <span style="font-variant-numeric:tabular-nums;font-size:12px;color:${pctColor(0)};width:50px;text-align:right">${fmtMinutes(stats.total)}</span>
        <span style="font-size:11px;color:var(--text-dim);min-width:40px;text-align:right;margin-left:8px">${stats.count} lekt.</span>
      </div>
    `).join('');

  // Day-of-week pattern
  const dayMins = Array<number>(7).fill(0);
  const dayCounts = Array<number>(7).fill(0);
  for (const r of records) {
    if (r.dayOfWeek >= 0 && r.dayOfWeek <= 6) {
      dayMins[r.dayOfWeek] += r.totalAbsenceMinutes;
      dayCounts[r.dayOfWeek]++;
    }
  }
  const maxDayMin = Math.max(...dayMins, 1);

  const dayBars = DAY_SHORT.map((label, i) => {
    if (dayCounts[i] === 0) return '';
    const h = Math.round(dayMins[i] / 60 * 10) / 10;
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:3px 0;">
        <span style="font-size:11px;color:var(--text-muted);min-width:28px">${label}</span>
        <div class="att-bar-track" style="flex:1">
          <div class="att-bar-fill" style="width:${Math.min(100, (dayMins[i] / maxDayMin) * 100)}%;background:#c0392b"></div>
        </div>
        <span style="font-size:11px;font-variant-numeric:tabular-nums;color:var(--text-secondary);min-width:36px;text-align:right">${h} h</span>
      </div>
    `;
  }).join('');

  return `
    <div class="detail-panel">
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px">
        <span style="font-size:12px;background:var(--bg-elevated);padding:3px 10px;border-radius:4px;color:var(--text-secondary)">
          Oanmäld: <strong style="color:#c0392b">${summary.unexcusedPercent}%</strong>
        </span>
        <span style="font-size:12px;background:var(--bg-elevated);padding:3px 10px;border-radius:4px;color:var(--text-secondary)">
          Anmäld: <strong style="color:#27ae60">${summary.excusedPercent}%</strong>
        </span>
        <span style="font-size:12px;background:var(--bg-elevated);padding:3px 10px;border-radius:4px;color:var(--text-secondary)">
          Schemalagd tid: <strong>${fmtMinutes(summary.totalScheduledMinutes)}</strong>
        </span>
      </div>
      <div class="detail-grid">
        <div class="detail-section">
          <h4>Frånvaro per kurs</h4>
          ${courseRows || '<span style="color:var(--text-dim);font-size:12px">Ingen detaljdata</span>'}
        </div>
        <div class="detail-section">
          <h4>Mönster per veckodag</h4>
          ${dayBars || '<span style="color:var(--text-dim);font-size:12px">Ingen detaljdata</span>'}
        </div>
      </div>
    </div>
  `;
}

function renderAttendance(): void {
  destroyCharts();

  const summaries = sortedSummaries();

  if (summaries.length === 0) {
    main().innerHTML = renderEmpty(
      'Närvaro',
      '&#128202;',
      'Ingen frånvarodata insamlad',
      'Besök frånvarosidan i Progress. Data samlas in automatiskt.'
    );
    return;
  }

  const recsByStudent = filteredRecordsByStudent();

  const rows = summaries.map((s) => {
    const isExpanded = expandedStudentName === s.studentName;
    const absHours = Math.round((s.unexcusedMinutes + s.excusedMinutes) / 60 * 10) / 10;
    const schedHours = Math.round(s.totalScheduledMinutes / 60 * 10) / 10;
    const flagTag = s.isFlagged
      ? `<span class="grade-badge" style="background:#c0392b20;color:#c0392b;border:1px solid #c0392b40;margin-left:6px;font-size:10px;padding:1px 5px">FLAGGAD</span>`
      : '';

    return `
      <tr data-student="${esc(s.studentName)}" style="${rowBgStyle(s.totalAbsencePercent)}" class="${isExpanded ? 'expanded' : ''}">
        <td>
          <strong>${esc(s.studentName)}</strong>${flagTag}
          ${s.className ? `<span style="color:var(--text-dim);font-size:11px;display:block">${esc(s.className)}</span>` : ''}
        </td>
        <td style="font-variant-numeric:tabular-nums;font-weight:600;color:${pctColor(s.totalAbsencePercent)}">${s.totalAbsencePercent}%</td>
        <td style="font-variant-numeric:tabular-nums;font-size:12px;color:#c0392b">${s.unexcusedPercent}%</td>
        <td style="font-variant-numeric:tabular-nums;font-size:12px;color:#27ae60">${s.excusedPercent}%</td>
        <td style="color:var(--text-secondary);font-size:12px">${schedHours} h</td>
        <td style="font-variant-numeric:tabular-nums;font-size:12px;color:var(--text-secondary)">${absHours} h</td>
      </tr>
      ${isExpanded ? `<tr><td colspan="6" style="padding:0">${renderExpansion(s, recsByStudent.get(s.studentName) ?? [])}</td></tr>` : ''}
    `;
  }).join('');

  main().innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <h2 class="page-title" style="margin-bottom:0">Närvaro</h2>
        <p class="page-subtitle">${summaries.length} elever sorterade efter total frånvaro — klicka för detaljer</p>
      </div>
      <button id="btn-export-attendance" class="btn" style="padding:6px 14px;font-size:12px;white-space:nowrap">Exportera CSV</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead>
          <tr>
            <th>Elev</th>
            <th>Total %</th>
            <th style="color:#c0392b">Oanmäld %</th>
            <th style="color:#27ae60">Anmäld %</th>
            <th>Schema</th>
            <th>Frånvaro</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  document.getElementById('btn-export-attendance')?.addEventListener('click', () => {
    exportCsv(summaries.map(s => ({
      Elev: s.studentName,
      Klass: s.className,
      'Total %': s.totalAbsencePercent,
      'Oanmäld %': s.unexcusedPercent,
      'Anmäld %': s.excusedPercent,
      'Schema (min)': s.totalScheduledMinutes,
      'Frånvaro (min)': s.unexcusedMinutes + s.excusedMinutes,
    })), 'narvaro.csv');
  });

  document.querySelectorAll<HTMLElement>('tr[data-student]').forEach((row) => {
    row.addEventListener('click', () => {
      const name = row.dataset.student!;
      expandedStudentName = expandedStudentName === name ? null : name;
      renderAttendance();
    });
  });
}

// ---------------------------------------------------------------------------
// View: Mönster (Patterns) — only flagged students
// ---------------------------------------------------------------------------

function detectPatterns(studentName: string, records: AbsenceRecord[]): string[] {
  const patterns: string[] = [];
  if (records.length < 3) return patterns;

  const uniqueDates = new Set(records.map((r) => r.lessonStart));
  const total = uniqueDates.size;

  // Day-of-week
  const dayCount = Array<number>(5).fill(0);
  for (const r of records) {
    if (r.dayOfWeek >= 0 && r.dayOfWeek <= 4) dayCount[r.dayOfWeek]++;
  }
  for (let d = 0; d < 5; d++) {
    const pct = Math.round((dayCount[d] / total) * 100);
    if (pct >= 60) patterns.push(`Alltid frånvarande på ${DAY_NAMES[d].toLowerCase()}ar (${pct}%)`);
    else if (pct >= 40) patterns.push(`Ofta frånvarande på ${DAY_NAMES[d].toLowerCase()}ar (${pct}%)`);
  }

  // Time-of-day: morning = hourOfDay < 10
  const morningCount = records.filter((r) => r.hourOfDay < 10).length;
  const morningPct = Math.round((morningCount / records.length) * 100);
  if (morningPct >= 60) patterns.push(`Missar ofta morgonlektioner (${morningPct}% av frånvaron)`);

  return patterns;
}

function renderPatterns(): void {
  destroyCharts();

  const flagged = flaggedSummaries();

  if (flagged.length === 0) {
    main().innerHTML = data.studentSummaries.length === 0
      ? renderEmpty('Mönster', '&#128200;', 'Ingen frånvarodata insamlad', 'Samla in data från Progress.')
      : `
        <h2 class="page-title">Mönster</h2>
        <div class="empty">
          <div class="empty-icon">&#9989;</div>
          <div class="empty-text">Inga flaggade elever</div>
          <div class="empty-hint">Inga elever har ≥ ${ABSENCE_THRESHOLD}% total frånvaro.</div>
        </div>
      `;
    return;
  }

  const recsByStudent = filteredRecordsByStudent();

  const cards = flagged.map((s) => {
    const records = recsByStudent.get(s.studentName) ?? [];
    const patterns = detectPatterns(s.studentName, records);

    // Day-of-week bars
    const dayMins = Array<number>(7).fill(0);
    const dayCounts = Array<number>(7).fill(0);
    for (const r of records) {
      if (r.dayOfWeek >= 0 && r.dayOfWeek <= 6) {
        dayMins[r.dayOfWeek] += r.totalAbsenceMinutes;
        dayCounts[r.dayOfWeek]++;
      }
    }
    const maxDay = Math.max(...dayMins, 1);
    const dayBars = DAY_SHORT.slice(0, 5).map((label, i) => {
      const h = Math.round(dayMins[i] / 60 * 10) / 10;
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:2px 0;">
          <span style="font-size:11px;color:var(--text-muted);min-width:28px">${label}</span>
          <div class="att-bar-track" style="flex:1">
            <div class="att-bar-fill" style="width:${Math.min(100, (dayMins[i] / maxDay) * 100)}%;background:#c0392b"></div>
          </div>
          <span style="font-size:11px;font-variant-numeric:tabular-nums;color:var(--text-dim);min-width:30px;text-align:right">
            ${dayCounts[i] > 0 ? h + ' h' : '—'}
          </span>
        </div>
      `;
    }).join('');

    // Time-of-day buckets
    const timeBuckets = [0, 0, 0, 0, 0];
    const timeBucketLabels = ['08–10', '10–12', '12–14', '14–16', '16+'];
    for (const r of records) {
      const h = r.hourOfDay;
      if (h < 10) timeBuckets[0] += r.totalAbsenceMinutes;
      else if (h < 12) timeBuckets[1] += r.totalAbsenceMinutes;
      else if (h < 14) timeBuckets[2] += r.totalAbsenceMinutes;
      else if (h < 16) timeBuckets[3] += r.totalAbsenceMinutes;
      else timeBuckets[4] += r.totalAbsenceMinutes;
    }

    // Per-course breakdown
    const byCourse = new Map<string, number>();
    for (const r of records) {
      byCourse.set(r.courseName, (byCourse.get(r.courseName) ?? 0) + r.totalAbsenceMinutes);
    }
    const courseRows = [...byCourse.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([course, mins]) => `
        <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid var(--border-subtle);">
          <span style="color:var(--text-secondary)">${esc(course)}</span>
          <span style="font-variant-numeric:tabular-nums;color:var(--text-dim)">${fmtMinutes(mins)}</span>
        </div>
      `).join('');

    const safeName = s.studentName.replace(/[^a-zA-Z0-9]/g, '_');
    const todChartId = `chart-pat-tod-${safeName}`;

    return `
      <div class="card" style="margin-bottom:16px;border-left:3px solid #c0392b;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div>
            <strong style="font-size:14px">${esc(s.studentName)}</strong>
            ${s.className ? `<span style="color:var(--text-dim);margin-left:8px;font-size:12px">${esc(s.className)}</span>` : ''}
          </div>
          <div style="display:flex;gap:10px;align-items:center">
            <span style="font-variant-numeric:tabular-nums;font-size:16px;font-weight:700;color:#c0392b">${s.totalAbsencePercent}%</span>
            <span class="grade-badge" style="background:#c0392b20;color:#c0392b;border:1px solid #c0392b40;font-size:10px">FLAGGAD</span>
          </div>
        </div>

        ${patterns.length > 0 ? `
          <div style="margin-bottom:12px;display:flex;flex-wrap:wrap;gap:6px">
            ${patterns.map((p) => `
              <span style="font-size:12px;background:#d4a01720;color:#d4a017;border:1px solid #d4a01740;padding:2px 8px;border-radius:4px">
                &#9888; ${esc(p)}
              </span>
            `).join('')}
          </div>
        ` : ''}

        <div class="detail-grid">
          <div class="detail-section">
            <h4>Veckodag</h4>
            ${records.length > 0 ? dayBars : '<span style="color:var(--text-dim);font-size:12px">Ingen detaljdata</span>'}
          </div>
          <div class="detail-section">
            <h4>Tid på dagen</h4>
            <div style="height:100px;margin-top:4px"><canvas id="${todChartId}"></canvas></div>
          </div>
          <div class="detail-section">
            <h4>Per kurs</h4>
            ${courseRows || '<span style="color:var(--text-dim);font-size:12px">Ingen detaljdata</span>'}
          </div>
          <div class="detail-section">
            <h4>Sammanfattning</h4>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.8">
              <div>Oanmäld: <strong style="color:#c0392b">${s.unexcusedPercent}%</strong> (${s.unexcusedCount} tillfällen)</div>
              <div>Anmäld: <strong style="color:#27ae60">${s.excusedPercent}%</strong> (${s.excusedCount} tillfällen)</div>
              <div>Schema: <strong>${fmtMinutes(s.totalScheduledMinutes)}</strong></div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  main().innerHTML = `
    <h2 class="page-title">Mönster</h2>
    <p class="page-subtitle">${flagged.length} flaggade elever (≥ ${ABSENCE_THRESHOLD}% frånvaro) — detaljerade mönster</p>
    ${cards}
  `;

  // Draw time-of-day charts for each flagged student
  for (const s of flagged) {
    const records = recsByStudent.get(s.studentName) ?? [];
    if (records.length === 0) continue;

    const timeBuckets = [0, 0, 0, 0, 0];
    for (const r of records) {
      const h = r.hourOfDay;
      if (h < 10) timeBuckets[0] += r.totalAbsenceMinutes;
      else if (h < 12) timeBuckets[1] += r.totalAbsenceMinutes;
      else if (h < 14) timeBuckets[2] += r.totalAbsenceMinutes;
      else if (h < 16) timeBuckets[3] += r.totalAbsenceMinutes;
      else timeBuckets[4] += r.totalAbsenceMinutes;
    }

    const safeName = s.studentName.replace(/[^a-zA-Z0-9]/g, '_');
    const canvas = document.getElementById(`chart-pat-tod-${safeName}`) as HTMLCanvasElement | null;
    if (!canvas) continue;

    charts.push(new Chart(canvas.getContext('2d')!, {
      type: 'bar',
      data: {
        labels: ['08–10', '10–12', '12–14', '14–16', '16+'],
        datasets: [{
          data: timeBuckets.map((m) => Math.round(m / 60 * 10) / 10),
          backgroundColor: CHART_COLORS[4] + '80',
          borderColor: CHART_COLORS[4],
          borderWidth: 1,
          borderRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { ...darkTooltip(), callbacks: { label: (ctx) => `${ctx.parsed.y} h` } } },
        scales: darkScales(),
      },
    }));
  }
}

// ---------------------------------------------------------------------------
// View: Elever (Students)
// ---------------------------------------------------------------------------

function renderStudentProfile(s: StudentAbsenceSummary, records: AbsenceRecord[]): string {
  const byCourse = new Map<string, number>();
  const dayMins = Array<number>(7).fill(0);
  const timeBuckets = [0, 0, 0, 0, 0];

  for (const r of records) {
    byCourse.set(r.courseName, (byCourse.get(r.courseName) ?? 0) + r.totalAbsenceMinutes);
    if (r.dayOfWeek >= 0 && r.dayOfWeek <= 6) dayMins[r.dayOfWeek] += r.totalAbsenceMinutes;
    const h = r.hourOfDay;
    if (h < 10) timeBuckets[0] += r.totalAbsenceMinutes;
    else if (h < 12) timeBuckets[1] += r.totalAbsenceMinutes;
    else if (h < 14) timeBuckets[2] += r.totalAbsenceMinutes;
    else if (h < 16) timeBuckets[3] += r.totalAbsenceMinutes;
    else timeBuckets[4] += r.totalAbsenceMinutes;
  }

  const courseRows = [...byCourse.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([course, mins]) => `
      <div class="detail-item" style="padding:5px 0;border-bottom:1px solid var(--border-subtle);">
        <span class="detail-item-label" style="flex:1;font-size:12px">${esc(course)}</span>
        <span style="font-variant-numeric:tabular-nums;font-size:12px;color:var(--text-secondary)">${fmtMinutes(mins)}</span>
      </div>
    `).join('');

  const safeName = s.studentName.replace(/[^a-zA-Z0-9]/g, '_');
  const dayChartId = `chart-student-${safeName}-dow`;
  const timeChartId = `chart-student-${safeName}-tod`;

  // Recent absence events timeline
  const sorted = [...records].sort((a, b) => a.lessonStart.localeCompare(b.lessonStart));
  const recentRows = sorted.slice(-10).reverse().map((r) => `
    <div style="display:flex;gap:12px;padding:4px 0;border-bottom:1px solid var(--border-subtle);font-size:12px;">
      <span style="color:var(--text-dim);min-width:86px;font-variant-numeric:tabular-nums">${r.date}</span>
      <span style="flex:1;color:var(--text-secondary)">${esc(r.courseName)}</span>
      <span style="color:${r.isExcused ? '#27ae60' : '#c0392b'};font-variant-numeric:tabular-nums">${fmtMinutes(r.totalAbsenceMinutes)}</span>
      <span style="color:var(--text-dim);font-size:11px">${r.isExcused ? 'Anmäld' : 'Oanmäld'}</span>
    </div>
  `).join('');

  const absHours = Math.round((s.unexcusedMinutes + s.excusedMinutes) / 60 * 10) / 10;

  return `
    <div class="detail-panel" style="margin:0;border-radius:0 0 8px 8px">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:16px">
        <div class="stat-card" style="padding:12px 14px">
          <div class="stat-label">Total frånvaro</div>
          <div class="stat-value" style="font-size:20px;color:${pctColor(s.totalAbsencePercent)}">${s.totalAbsencePercent}%</div>
        </div>
        <div class="stat-card" style="padding:12px 14px">
          <div class="stat-label">Oanmäld</div>
          <div class="stat-value" style="font-size:20px;color:#c0392b">${s.unexcusedPercent}%</div>
        </div>
        <div class="stat-card" style="padding:12px 14px">
          <div class="stat-label">Anmäld</div>
          <div class="stat-value" style="font-size:20px;color:#27ae60">${s.excusedPercent}%</div>
        </div>
        <div class="stat-card" style="padding:12px 14px">
          <div class="stat-label">Frånvaro</div>
          <div class="stat-value" style="font-size:20px">${absHours} h</div>
        </div>
      </div>

      <div class="detail-grid">
        <div class="detail-section">
          <h4>Frånvaro per kurs</h4>
          ${courseRows || '<span style="color:var(--text-dim);font-size:12px">Ingen detaljdata</span>'}
        </div>
        <div class="detail-section">
          <h4>Senaste frånvarotillfällen</h4>
          ${recentRows || '<span style="color:var(--text-dim);font-size:12px">Ingen detaljdata</span>'}
        </div>
      </div>

      <div class="detail-grid" style="margin-top:16px">
        <div class="detail-section">
          <h4>Mönster — veckodag</h4>
          <div style="height:120px;margin-top:8px"><canvas id="${dayChartId}"></canvas></div>
        </div>
        <div class="detail-section">
          <h4>Mönster — tid på dagen</h4>
          <div style="height:120px;margin-top:8px"><canvas id="${timeChartId}"></canvas></div>
        </div>
      </div>
    </div>
  `;
}

function renderStudents(): void {
  destroyCharts();

  const summaries = sortedSummaries();

  if (summaries.length === 0) {
    main().innerHTML = renderEmpty(
      'Elever',
      '&#128100;',
      'Inga elever insamlade',
      'Besök elevsidor i Progress. Data samlas in automatiskt.'
    );
    return;
  }

  const recsByStudent = filteredRecordsByStudent();
  const searchId = 'student-search';
  const tableId = 'students-table';

  const rows = summaries.map((s) => {
    const isExpanded = expandedStudentName === s.studentName;
    const absHours = Math.round((s.unexcusedMinutes + s.excusedMinutes) / 60 * 10) / 10;
    const schedHours = Math.round(s.totalScheduledMinutes / 60 * 10) / 10;
    const flagTag = s.isFlagged
      ? `<span class="grade-badge" style="background:#c0392b20;color:#c0392b;border:1px solid #c0392b40;margin-left:6px;font-size:10px;padding:1px 5px">FLAGGAD</span>`
      : '';

    return `
      <tr data-student="${esc(s.studentName)}" style="${rowBgStyle(s.totalAbsencePercent)}" class="${isExpanded ? 'expanded' : ''}">
        <td>
          <strong>${esc(s.studentName)}</strong>${flagTag}
        </td>
        <td style="color:var(--text-muted)">${esc(s.className)}</td>
        <td style="font-variant-numeric:tabular-nums;font-weight:600;color:${pctColor(s.totalAbsencePercent)}">${s.totalAbsencePercent}%</td>
        <td style="font-variant-numeric:tabular-nums;font-size:12px;color:#c0392b">${s.unexcusedPercent}%</td>
        <td style="font-variant-numeric:tabular-nums;font-size:12px;color:#27ae60">${s.excusedPercent}%</td>
        <td style="font-variant-numeric:tabular-nums;font-size:12px;color:var(--blue-600)">${fmtMerit(s.studentName)}</td>
        <td style="font-variant-numeric:tabular-nums;font-size:12px;color:var(--text-secondary)">${absHours} h</td>
      </tr>
      ${isExpanded ? `<tr data-detail="${esc(s.studentName)}"><td colspan="7" style="padding:0">${renderStudentProfile(s, recsByStudent.get(s.studentName) ?? [])}</td></tr>` : ''}
    `;
  }).join('');

  main().innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <h2 class="page-title" style="margin-bottom:0">Elever</h2>
        <p class="page-subtitle">${summaries.length} elever — klicka för detaljprofil</p>
      </div>
      <button id="btn-export-students" class="btn" style="padding:6px 14px;font-size:12px;white-space:nowrap">Exportera CSV</button>
    </div>
    <div style="margin-bottom:12px">
      <input id="${searchId}" type="text" placeholder="Sök elev..." style="
        background:var(--bg-card);border:1px solid var(--border);border-radius:8px;
        padding:8px 12px;color:var(--text-primary);font-size:13px;width:280px;
        font-family:var(--font);outline:none;
      "/>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <table id="${tableId}">
        <thead>
          <tr>
            <th>Namn</th>
            <th>Klass</th>
            <th>Total %</th>
            <th style="color:#c0392b">Oanmäld %</th>
            <th style="color:#27ae60">Anmäld %</th>
            <th>Meritvärde</th>
            <th>Frånvaro</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  document.getElementById('btn-export-students')?.addEventListener('click', () => {
    exportCsv(summaries.map(s => ({
      Namn: s.studentName,
      Klass: s.className,
      'Total %': s.totalAbsencePercent,
      'Oanmäld %': s.unexcusedPercent,
      'Anmäld %': s.excusedPercent,
      'Schema (min)': s.totalScheduledMinutes,
      'Frånvaro (min)': s.unexcusedMinutes + s.excusedMinutes,
    })), 'elever.csv');
  });

  // Search filter
  document.getElementById(searchId)!.addEventListener('input', (e) => {
    const query = (e.target as HTMLInputElement).value.toLowerCase();
    document.querySelectorAll<HTMLElement>(`#${tableId} tr[data-student]`).forEach((row) => {
      const name = row.dataset.student ?? '';
      const visible = name.toLowerCase().includes(query);
      row.style.display = visible ? '' : 'none';
      const next = row.nextElementSibling as HTMLElement | null;
      if (next?.dataset.detail) next.style.display = visible ? '' : 'none';
    });
  });

  // Expand on click + draw mini charts
  document.querySelectorAll<HTMLElement>(`#${tableId} tr[data-student]`).forEach((row) => {
    row.addEventListener('click', () => {
      const name = row.dataset.student!;
      expandedStudentName = expandedStudentName === name ? null : name;
      renderStudents();

      if (expandedStudentName === name) {
        const summary = summaries.find((s) => s.studentName === name);
        if (!summary) return;

        const records = recsByStudent.get(name) ?? [];
        const safeName = name.replace(/[^a-zA-Z0-9]/g, '_');
        const dayChartId = `chart-student-${safeName}-dow`;
        const timeChartId = `chart-student-${safeName}-tod`;

        const dayMins = Array<number>(7).fill(0);
        const timeBuckets = [0, 0, 0, 0, 0];
        for (const r of records) {
          if (r.dayOfWeek >= 0 && r.dayOfWeek <= 6) dayMins[r.dayOfWeek] += r.totalAbsenceMinutes;
          const h = r.hourOfDay;
          if (h < 10) timeBuckets[0] += r.totalAbsenceMinutes;
          else if (h < 12) timeBuckets[1] += r.totalAbsenceMinutes;
          else if (h < 14) timeBuckets[2] += r.totalAbsenceMinutes;
          else if (h < 16) timeBuckets[3] += r.totalAbsenceMinutes;
          else timeBuckets[4] += r.totalAbsenceMinutes;
        }

        const dowCanvas = document.getElementById(dayChartId) as HTMLCanvasElement | null;
        if (dowCanvas) {
          charts.push(new Chart(dowCanvas.getContext('2d')!, {
            type: 'bar',
            data: {
              labels: DAY_SHORT,
              datasets: [{ data: dayMins.map((m) => Math.round(m / 60 * 10) / 10), backgroundColor: '#55387680', borderColor: '#553876', borderWidth: 1, borderRadius: 3 }],
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { ...darkTooltip() } }, scales: darkScales() },
          }));
        }

        const todCanvas = document.getElementById(timeChartId) as HTMLCanvasElement | null;
        if (todCanvas) {
          charts.push(new Chart(todCanvas.getContext('2d')!, {
            type: 'bar',
            data: {
              labels: ['08–10', '10–12', '12–14', '14–16', '16+'],
              datasets: [{ data: timeBuckets.map((m) => Math.round(m / 60 * 10) / 10), backgroundColor: '#06b6d480', borderColor: '#06b6d4', borderWidth: 1, borderRadius: 3 }],
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { ...darkTooltip() } }, scales: darkScales() },
          }));
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// View: Riskindikator (Risk)
// ---------------------------------------------------------------------------

type RiskLevel = 'high' | 'medium';

interface RiskEntry {
  readonly summary: StudentAbsenceSummary;
  readonly level: RiskLevel;
  readonly reasons: string[];
}

function buildRiskEntries(): RiskEntry[] {
  const flagged = flaggedSummaries();
  const recsByStudent = filteredRecordsByStudent();
  const entries: RiskEntry[] = [];

  for (const s of flagged) {
    const reasons: string[] = [];
    let isHigh = false;

    // High risk: >= 30% total or >= 20% unexcused
    if (s.totalAbsencePercent >= 30) {
      reasons.push(`${s.totalAbsencePercent}% total frånvaro`);
      isHigh = true;
    } else {
      reasons.push(`${s.totalAbsencePercent}% total frånvaro`);
    }

    if (s.unexcusedPercent >= 20) {
      reasons.push(`${s.unexcusedPercent}% oanmäld frånvaro`);
      isHigh = true;
    } else if (s.unexcusedPercent > 0) {
      reasons.push(`${s.unexcusedPercent}% oanmäld frånvaro`);
    }

    // Check day patterns from records
    const records = recsByStudent.get(s.studentName) ?? [];
    const patterns = detectPatterns(s.studentName, records);
    for (const p of patterns) {
      reasons.push(p);
      if (p.startsWith('Alltid')) isHigh = true;
    }

    entries.push({ summary: s, level: isHigh ? 'high' : 'medium', reasons });
  }

  return entries.sort((a, b) => {
    if (a.level !== b.level) return a.level === 'high' ? -1 : 1;
    return b.summary.totalAbsencePercent - a.summary.totalAbsencePercent;
  });
}

function renderRisk(): void {
  destroyCharts();

  if (data.studentSummaries.length === 0) {
    main().innerHTML = renderEmpty(
      'Riskindikator',
      '&#9888;',
      'Ingen frånvarodata insamlad',
      'Samla in data från Progress för att se riskindikationer.'
    );
    return;
  }

  const entries = buildRiskEntries();

  if (entries.length === 0) {
    main().innerHTML = `
      <h2 class="page-title">Riskindikator</h2>
      <div class="empty">
        <div class="empty-icon">&#9989;</div>
        <div class="empty-text">Inga riskindikerade elever</div>
        <div class="empty-hint">Inga elever har ≥ ${ABSENCE_THRESHOLD}% frånvaro.</div>
      </div>
    `;
    return;
  }

  const highCount = entries.filter((e) => e.level === 'high').length;
  const medCount = entries.filter((e) => e.level === 'medium').length;
  const recsByStudent = filteredRecordsByStudent();

  const cards = entries.map((entry) => {
    const { summary: s, level, reasons } = entry;
    const isExpanded = expandedStudentName === s.studentName;
    const levelLabel = level === 'high' ? 'Hög risk' : 'Medelhög risk';
    const levelClass = level === 'high' ? 'risk-high' : 'risk-med';
    const tagClass = level === 'high' ? 'risk-tag-high' : 'risk-tag-med';

    const absHours = Math.round((s.unexcusedMinutes + s.excusedMinutes) / 60 * 10) / 10;

    return `
      <div class="card ${levelClass}" style="cursor:pointer;margin-bottom:10px" data-student="${esc(s.studentName)}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <strong style="font-size:14px">${esc(s.studentName)}</strong>
            ${s.className ? `<span style="color:var(--text-dim);margin-left:8px;font-size:12px">${esc(s.className)}</span>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;margin-left:16px">
            <span style="font-variant-numeric:tabular-nums;font-size:15px;font-weight:700;color:${pctColor(s.totalAbsencePercent)}">${s.totalAbsencePercent}%</span>
            <span style="font-variant-numeric:tabular-nums;font-size:12px;color:var(--text-dim)">${absHours} h</span>
            <span class="risk-tag ${tagClass}">${levelLabel}</span>
          </div>
        </div>
        <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">
          ${reasons.map((r) => `<span style="font-size:12px;color:var(--text-dim);background:var(--bg-elevated);padding:2px 8px;border-radius:4px">${esc(r)}</span>`).join('')}
        </div>
        ${isExpanded ? renderExpansion(s, recsByStudent.get(s.studentName) ?? []) : ''}
      </div>
    `;
  }).join('');

  main().innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <h2 class="page-title" style="margin-bottom:0">Riskindikator</h2>
        <p class="page-subtitle">
          <span style="color:#c0392b;font-weight:600">${highCount} hög risk</span>
          <span style="color:var(--text-dim);margin:0 8px">·</span>
          <span style="color:#d4a017;font-weight:600">${medCount} medelhög risk</span>
          <span style="color:var(--text-dim);margin-left:8px">— klicka för detaljer</span>
        </p>
      </div>
      <button id="btn-export-risk" class="btn" style="padding:6px 14px;font-size:12px;white-space:nowrap">Exportera CSV</button>
    </div>
    ${cards}
  `;

  document.getElementById('btn-export-risk')?.addEventListener('click', () => {
    exportCsv(entries.map(e => ({
      Elev: e.summary.studentName,
      Klass: e.summary.className,
      Risknivå: e.level === 'high' ? 'Hög' : 'Medelhög',
      'Total %': e.summary.totalAbsencePercent,
      'Oanmäld %': e.summary.unexcusedPercent,
      Orsaker: e.reasons.join(', '),
    })), 'riskindikator.csv');
  });

  document.querySelectorAll<HTMLElement>('[data-student]').forEach((el) => {
    el.addEventListener('click', () => {
      const name = el.dataset.student!;
      expandedStudentName = expandedStudentName === name ? null : name;
      renderRisk();
    });
  });
}

// ---------------------------------------------------------------------------
// View: Årsvy (Year view)
// ---------------------------------------------------------------------------

/** Find a PeriodSummary by its period label key */
function getPeriod(label: 'year' | 'ht' | 'vt' | 'recent') {
  return (data.periodSummaries ?? []).find((p) => p.period === label);
}

function renderYearView(): void {
  destroyCharts();

  const hasPeriods = (data.periodSummaries ?? []).length > 0;
  const hasRecords = data.absenceRecords.length > 0;

  if (!hasPeriods && !hasRecords) {
    main().innerHTML = renderEmpty(
      'Årsvy',
      '&#128197;',
      'Ingen årsdata tillgänglig',
      'Samla in perioddata från Progress för att se helårsvyn.'
    );
    return;
  }

  // ── Period overview stats ──────────────────────────────────────────────────

  const periodDefs: Array<{ key: 'year' | 'ht' | 'vt' | 'recent'; label: string; icon: string }> = [
    { key: 'year',   label: 'Helår',             icon: '&#128197;' },
    { key: 'ht',     label: 'HT (Hösttermin)',   icon: '&#127810;' },
    { key: 'vt',     label: 'VT (Vårtermin)',     icon: '&#127800;' },
    { key: 'recent', label: 'Senaste 2 mån',      icon: '&#128336;' },
  ];

  const periodCards = periodDefs.map(({ key, label, icon }) => {
    const period = getPeriod(key);
    if (!period) {
      return `
        <div class="stat-card" style="opacity:0.5">
          <div class="stat-label">${icon} ${label}</div>
          <div class="stat-value" style="font-size:18px;color:var(--text-dim)">—</div>
          <div class="stat-sub">Ingen data</div>
        </div>
      `;
    }
    const { summaries } = period;
    const avgPct = summaries.length > 0
      ? Math.round(summaries.reduce((acc, s) => acc + s.totalAbsencePercent, 0) / summaries.length * 10) / 10
      : 0;
    const flaggedCount = summaries.filter((s) => s.isFlagged).length;
    const totalStudents = summaries.length;

    return `
      <div class="stat-card">
        <div class="stat-label">${icon} ${label}</div>
        <div class="stat-value" style="color:${pctColor(avgPct)}">${avgPct}%</div>
        <div class="stat-sub">
          <span style="color:#c0392b">${flaggedCount} flaggade</span>
          <span style="color:var(--text-dim);margin-left:6px">av ${totalStudents} elever</span>
        </div>
      </div>
    `;
  }).join('');

  // ── HT vs VT comparison table ──────────────────────────────────────────────

  const htPeriod = getPeriod('ht');
  const vtPeriod = getPeriod('vt');

  let comparisonTable = '';
  if (htPeriod && vtPeriod) {
    // Build map of VT summaries keyed by studentName
    const vtMap = new Map(vtPeriod.summaries.map((s) => [s.studentName, s]));

    interface CompRow {
      readonly studentName: string;
      readonly className: string;
      readonly htPct: number;
      readonly vtPct: number;
      readonly delta: number;
    }

    const rows: CompRow[] = [];
    for (const htS of htPeriod.summaries) {
      const vtS = vtMap.get(htS.studentName);
      if (!vtS) continue;
      rows.push({
        studentName: htS.studentName,
        className: htS.className,
        htPct: htS.totalAbsencePercent,
        vtPct: vtS.totalAbsencePercent,
        delta: vtS.totalAbsencePercent - htS.totalAbsencePercent,
      });
    }

    // Sort by delta descending (most worsened first)
    rows.sort((a, b) => b.delta - a.delta);

    const tableRows = rows.map((row) => {
      const { delta } = row;
      const deltaColor = delta > 0 ? '#c0392b' : delta < 0 ? '#27ae60' : 'var(--text-dim)';
      const deltaSign = delta > 0 ? '+' : '';
      const trendArrow = delta > 5 ? '&#8679;' : delta < -5 ? '&#8681;' : '&#8596;';
      const trendColor = delta > 5 ? '#c0392b' : delta < -5 ? '#27ae60' : 'var(--text-dim)';
      const statusTag = delta > 5
        ? `<span class="grade-badge" style="background:#c0392b20;color:#c0392b;border:1px solid #c0392b40;font-size:10px">Försämrad</span>`
        : delta < -5
        ? `<span class="grade-badge" style="background:#27ae6020;color:#27ae60;border:1px solid #27ae6040;font-size:10px">Förbättrad</span>`
        : `<span class="grade-badge" style="background:#71717a20;color:#71717a;border:1px solid #71717a40;font-size:10px">Stabil</span>`;

      return `
        <tr>
          <td><strong>${esc(row.studentName)}</strong></td>
          <td style="color:var(--text-muted);font-size:12px">${esc(row.className)}</td>
          <td style="font-variant-numeric:tabular-nums;color:${pctColor(row.htPct)}">${row.htPct}%</td>
          <td style="font-variant-numeric:tabular-nums;color:${pctColor(row.vtPct)}">${row.vtPct}%</td>
          <td style="font-variant-numeric:tabular-nums;font-weight:600;color:${deltaColor}">${deltaSign}${delta}%</td>
          <td style="font-size:16px;color:${trendColor};text-align:center">${trendArrow}</td>
          <td>${statusTag}</td>
        </tr>
      `;
    }).join('');

    comparisonTable = `
      <div class="card" style="margin-bottom:20px">
        <div class="card-header">
          <span class="card-title">HT vs VT — Jämförelse per elev</span>
          <span style="font-size:12px;color:var(--text-dim)">${rows.length} elever med data för båda terminerna</span>
        </div>
        <div style="overflow-x:auto">
          <table>
            <thead>
              <tr>
                <th>Elev</th>
                <th>Klass</th>
                <th style="color:#d4a017">HT %</th>
                <th style="color:#06b6d4">VT %</th>
                <th>Förändring</th>
                <th style="text-align:center">Trend</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </div>
    `;
  } else {
    comparisonTable = `
      <div class="card" style="margin-bottom:20px;opacity:0.6">
        <div class="card-header"><span class="card-title">HT vs VT — Jämförelse per elev</span></div>
        <p style="color:var(--text-dim);font-size:13px;padding:8px 0">Data för HT och/eller VT saknas.</p>
      </div>
    `;
  }

  // ── Monthly absence trend (bar chart from absenceRecords) ─────────────────

  // School year months: Aug=7 → Mar=2 (next year)
  const SCHOOL_MONTHS: Array<{ month: number; yearOffset: number; label: string }> = [
    { month: 7,  yearOffset: 0, label: 'Aug' },
    { month: 8,  yearOffset: 0, label: 'Sep' },
    { month: 9,  yearOffset: 0, label: 'Okt' },
    { month: 10, yearOffset: 0, label: 'Nov' },
    { month: 11, yearOffset: 0, label: 'Dec' },
    { month: 0,  yearOffset: 1, label: 'Jan' },
    { month: 1,  yearOffset: 1, label: 'Feb' },
    { month: 2,  yearOffset: 1, label: 'Mar' },
  ];

  // Count total absence minutes per school-year month bucket
  const monthMinutes = Array<number>(SCHOOL_MONTHS.length).fill(0);
  for (const r of data.absenceRecords) {
    const d = new Date(r.date);
    if (isNaN(d.getTime())) continue;
    const m = d.getMonth();
    const idx = SCHOOL_MONTHS.findIndex((sm) => sm.month === m);
    if (idx !== -1) monthMinutes[idx] += r.totalAbsenceMinutes;
  }

  const monthHours = monthMinutes.map((m) => Math.round(m / 60 * 10) / 10);
  const hasMonthData = monthHours.some((h) => h > 0);

  // ── Students to watch ─────────────────────────────────────────────────────

  let studentsToWatch = '';
  if (htPeriod && vtPeriod) {
    const vtMap = new Map(vtPeriod.summaries.map((s) => [s.studentName, s]));

    interface WatchEntry {
      readonly studentName: string;
      readonly className: string;
      readonly htPct: number;
      readonly vtPct: number;
      readonly delta: number;
    }

    const worsened: WatchEntry[] = [];
    const improved: WatchEntry[] = [];

    for (const htS of htPeriod.summaries) {
      const vtS = vtMap.get(htS.studentName);
      if (!vtS) continue;
      const delta = vtS.totalAbsencePercent - htS.totalAbsencePercent;
      const entry: WatchEntry = {
        studentName: htS.studentName,
        className: htS.className,
        htPct: htS.totalAbsencePercent,
        vtPct: vtS.totalAbsencePercent,
        delta,
      };
      if (delta > 5) worsened.push(entry);
      else if (delta < -5) improved.push(entry);
    }

    worsened.sort((a, b) => b.delta - a.delta);
    improved.sort((a, b) => a.delta - b.delta);

    const worsenedRows = worsened.map((e) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border-subtle);">
        <div>
          <strong style="font-size:13px">${esc(e.studentName)}</strong>
          <span style="color:var(--text-dim);font-size:11px;margin-left:8px">${esc(e.className)}</span>
        </div>
        <div style="display:flex;gap:12px;align-items:center">
          <span style="font-size:12px;color:var(--text-dim)">HT: <span style="font-variant-numeric:tabular-nums;color:${pctColor(e.htPct)}">${e.htPct}%</span></span>
          <span style="font-size:12px;color:var(--text-dim)">VT: <span style="font-variant-numeric:tabular-nums;color:${pctColor(e.vtPct)}">${e.vtPct}%</span></span>
          <span style="font-variant-numeric:tabular-nums;font-weight:600;color:#c0392b">+${e.delta}%</span>
        </div>
      </div>
    `).join('');

    const improvedRows = improved.map((e) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border-subtle);">
        <div>
          <strong style="font-size:13px">${esc(e.studentName)}</strong>
          <span style="color:var(--text-dim);font-size:11px;margin-left:8px">${esc(e.className)}</span>
        </div>
        <div style="display:flex;gap:12px;align-items:center">
          <span style="font-size:12px;color:var(--text-dim)">HT: <span style="font-variant-numeric:tabular-nums;color:${pctColor(e.htPct)}">${e.htPct}%</span></span>
          <span style="font-size:12px;color:var(--text-dim)">VT: <span style="font-variant-numeric:tabular-nums;color:${pctColor(e.vtPct)}">${e.vtPct}%</span></span>
          <span style="font-variant-numeric:tabular-nums;font-weight:600;color:#27ae60">${e.delta}%</span>
        </div>
      </div>
    `).join('');

    studentsToWatch = `
      <div class="card-grid">
        <div class="card">
          <div class="card-header">
            <span class="card-title" style="color:#c0392b">&#8679; Försämrade (VT &gt; HT med &gt;5%)</span>
          </div>
          ${worsened.length > 0
            ? worsenedRows
            : '<p style="color:var(--text-dim);font-size:13px;padding:4px 0">Inga elever har försämrats markant.</p>'}
        </div>
        <div class="card">
          <div class="card-header">
            <span class="card-title" style="color:#27ae60">&#8681; Förbättrade (VT &lt; HT med &gt;5%)</span>
          </div>
          ${improved.length > 0
            ? improvedRows
            : '<p style="color:var(--text-dim);font-size:13px;padding:4px 0">Inga elever har förbättrats markant.</p>'}
        </div>
      </div>
    `;
  }

  // ── Render HTML ────────────────────────────────────────────────────────────

  const totalStudentsYear = getPeriod('year')?.summaries.length ?? data.studentSummaries.length;

  main().innerHTML = `
    <h2 class="page-title">Årsvy</h2>
    <p class="page-subtitle">Helårsöversikt — ${totalStudentsYear} elever</p>

    <div class="stats-row">
      ${periodCards}
    </div>

    ${comparisonTable}

    <div class="card-grid" style="margin-bottom:20px">
      <div class="card">
        <div class="card-header"><span class="card-title">Frånvarotimmar per månad</span></div>
        <div class="chart-container"><canvas id="chart-year-monthly"></canvas></div>
      </div>
    </div>

    ${studentsToWatch}
  `;

  // Monthly trend bar chart
  if (hasMonthData) {
    const monthlyCtx = (document.getElementById('chart-year-monthly') as HTMLCanvasElement).getContext('2d')!;
    const barColors = SCHOOL_MONTHS.map((_, i) => i < 5 ? '#d4a01780' : '#06b6d480');
    const borderColors = SCHOOL_MONTHS.map((_, i) => i < 5 ? '#d4a017' : '#06b6d4');

    charts.push(new Chart(monthlyCtx, {
      type: 'bar',
      data: {
        labels: SCHOOL_MONTHS.map((m) => m.label),
        datasets: [{
          label: 'Frånvarotimmar',
          data: monthHours,
          backgroundColor: barColors,
          borderColor: borderColors,
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            ...darkTooltip(),
            callbacks: { label: (ctx) => `${ctx.parsed.y} h frånvaro` },
          },
        },
        scales: darkScales({ yTitle: 'Timmar', xTitle: 'Månad' }),
      },
    }));
  }
}

// ---------------------------------------------------------------------------
// View: Rapporter (Report cards)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Recommendation engine — types (local to this module)
// ---------------------------------------------------------------------------

interface Recommendation {
  text: string;
  severity: 'critical' | 'warning' | 'info';
  category: 'legal' | 'action' | 'pattern' | 'insight';
  role: 'mentor' | 'teacher' | 'elevhalsa' | 'rektor' | 'all';
}

interface RecommendationSet {
  tier: 1 | 2 | 3 | 4;
  tierLabel: string;
  recommendations: Recommendation[];
}

/** Evidence-based, role-specific Swedish recommendation engine for a single student. */
function generateRecommendations(studentName: string): RecommendationSet {
  const summary = data.studentSummaries.find((s) => s.studentName === studentName);

  // Fallback for unknown student
  if (!summary) {
    return { tier: 1, tierLabel: 'Universell prevention', recommendations: [] };
  }

  const records = recordsByStudent().get(studentName) ?? [];
  const totalPct = summary.totalAbsencePercent;
  const unexPct = summary.unexcusedPercent;
  const exPct = summary.excusedPercent;

  // ── Tier classification ──────────────────────────────────────────────────
  const tier: 1 | 2 | 3 | 4 =
    totalPct >= 30 ? 4 :
    totalPct >= 15 ? 3 :
    totalPct >= 5  ? 2 :
    1;

  const tierLabel =
    tier === 4 ? 'Krisnivå' :
    tier === 3 ? 'Intensiva insatser' :
    tier === 2 ? 'Riktade insatser' :
    'Universell prevention';

  const recs: Recommendation[] = [];

  // ── Legal compliance ─────────────────────────────────────────────────────

  if (tier >= 3) {
    recs.push({
      text: 'Utredning KRÄVS enligt Skollagen 7 kap. 19a § — elevens frånvaro är upprepad/långvarig. Har utredning initierats i samråd med elev, vårdnadshavare och elevhälsoteam?',
      severity: 'critical',
      category: 'legal',
      role: 'rektor',
    });
  }

  if (tier >= 3 && unexPct > 50) {
    recs.push({
      text: `Hög andel oanmäld frånvaro (${unexPct}%). Överväg orosanmälan till socialtjänsten enligt SoL 14 kap. 1 § om det finns misstanke om att eleven far illa.`,
      severity: 'critical',
      category: 'legal',
      role: 'rektor',
    });
  }

  if (tier === 4) {
    recs.push({
      text: 'Elevens frånvaro överstiger 30%. Säkerställ att alla lagstadgade åtgärder dokumenteras. Om huvudman skiljer sig från hemkommun ska hemkommunen informeras inom 5 arbetsdagar.',
      severity: 'critical',
      category: 'legal',
      role: 'rektor',
    });
  }

  // ── Pattern analysis ─────────────────────────────────────────────────────

  if (records.length > 0) {
    const totalRecords = records.length;
    const totalMinutes = records.reduce((acc, r) => acc + r.totalAbsenceMinutes, 0);

    // Mon/Fri pattern
    const monFriCount = records.filter((r) => r.dayOfWeek === 0 || r.dayOfWeek === 4).length;
    const monFriShare = Math.round((monFriCount / totalRecords) * 100);
    if (monFriShare >= 50) {
      recs.push({
        text: `Frånvaron är koncentrerad till måndagar och fredagar (${monFriShare}% av all frånvaro). Forskning visar att detta mönster ofta signalerar bristande engagemang eller problematisk helgsituation. Rekommendation: Undersök familjesituationen och schemalägg viktiga aktiviteter på dessa dagar.`,
        severity: 'warning',
        category: 'pattern',
        role: 'mentor',
      });
    }

    // Morning pattern
    if (totalMinutes > 0) {
      const morningMinutes = records
        .filter((r) => r.hourOfDay < 10)
        .reduce((acc, r) => acc + r.totalAbsenceMinutes, 0);
      const morningShare = Math.round((morningMinutes / totalMinutes) * 100);
      if (morningShare > 50) {
        recs.push({
          text: `Frånvaron sker främst på morgonlektioner (${morningShare}% före kl 10). Detta kan tyda på sömnproblem, depression eller kaotisk morgonsituation hemma. Rekommendation: Screena för sömnvanor och psykisk ohälsa via elevhälsan.`,
          severity: 'warning',
          category: 'pattern',
          role: 'mentor',
        });
      }
    }

    // Course-specific concentration
    const byCourse = new Map<string, number>();
    for (const r of records) {
      byCourse.set(r.courseName, (byCourse.get(r.courseName) ?? 0) + 1);
    }
    for (const [courseName, count] of byCourse) {
      const share = Math.round((count / totalRecords) * 100);
      if (share >= 40) {
        recs.push({
          text: `Frånvaron är koncentrerad till ${courseName} (${share}% av all frånvaro). Detta kan signalera ämnesångest, svårigheter med lärstilen, eller relationsproblem med undervisande lärare. Rekommendation: Samtal med ämneslärare och eventuell klassrumsobservation.`,
          severity: 'warning',
          category: 'pattern',
          role: 'teacher',
        });
        break;
      }
    }

    // Excused ratio insight
    if (totalPct > 0 && exPct / totalPct > 0.8) {
      recs.push({
        text: `Majoriteten av frånvaron (${exPct}%) är anmäld. Utred om medicinska orsaker är genuina eller om det döljer skolundvikande beteende — forskning visar att hög sjukfrånvaro ibland maskerar ångestdriven skolfrånvaro.`,
        severity: 'info',
        category: 'pattern',
        role: 'elevhalsa',
      });
    }

    // High unexcused
    if (unexPct > 50) {
      recs.push({
        text: `Hög andel oanmäld frånvaro (${unexPct}%). Detta signalerar bristande rutiner eller aktivt skolundvikande. Prioritera personlig kontakt med vårdnadshavare per telefon (inte bara digitalt).`,
        severity: 'warning',
        category: 'pattern',
        role: 'mentor',
      });
    }
  }

  // Sudden increase — HT vs VT
  const htPeriod = getPeriod('ht');
  const vtPeriod = getPeriod('vt');
  const htS = htPeriod?.summaries.find((s) => s.studentName === studentName);
  const vtS = vtPeriod?.summaries.find((s) => s.studentName === studentName);

  if (htS && vtS) {
    const diff = vtS.totalAbsencePercent - htS.totalAbsencePercent;
    if (diff > 10) {
      recs.push({
        text: `Frånvaron har ökat markant från ${htS.totalAbsencePercent}% till ${vtS.totalAbsencePercent}%. En plötslig ökning kräver snabb utredning av nya omständigheter (mobbning, familjeförändringar, psykisk ohälsa).`,
        severity: 'warning',
        category: 'pattern',
        role: 'mentor',
      });
    } else if (diff < -5) {
      recs.push({
        text: `Positiv utveckling — frånvaron har minskat från ${htS.totalAbsencePercent}% till ${vtS.totalAbsencePercent}%. Fortsätt nuvarande insatser och bekräfta elevens ansträngning.`,
        severity: 'info',
        category: 'insight',
        role: 'all',
      });
    }
  }

  // ── Role-specific actions ────────────────────────────────────────────────

  if (tier === 2) {
    recs.push({
      text: "Genomför ett personligt samtal med eleven ('Jag har märkt att du varit borta...'). Kontakta vårdnadshavare per telefon. Dokumentera samtalet.",
      severity: 'warning',
      category: 'action',
      role: 'mentor',
    });
    recs.push({
      text: 'Upprätta en skriftlig närvaroplan med eleven — specifika mål, veckovis uppföljning, positiv förstärkning vid förbättring.',
      severity: 'warning',
      category: 'action',
      role: 'mentor',
    });
    recs.push({
      text: 'Informera elevhälsoteamet och begär konsultation. Screena för bakomliggande orsaker (ångest, mobbning, inlärningssvårigheter).',
      severity: 'warning',
      category: 'action',
      role: 'elevhalsa',
    });
  }

  if (tier === 3) {
    recs.push({
      text: 'Inled strukturerade dagliga incheckningar (Check-In/Check-Out) — kort morgonsamtal och eftermiddagsavstämning.',
      severity: 'critical',
      category: 'action',
      role: 'mentor',
    });
    recs.push({
      text: 'Kontakta vårdnadshavare personligen och boka möte med elevhälsoteam, elev och vårdnadshavare gemensamt.',
      severity: 'critical',
      category: 'action',
      role: 'mentor',
    });
    recs.push({
      text: 'Genomför en fullständig utredning: kartlägg orsaker inom skola, familj, individ och kamratrelationer. Involvera kurator, skolsköterska och specialpedagog.',
      severity: 'critical',
      category: 'action',
      role: 'elevhalsa',
    });
    recs.push({
      text: 'Säkerställ att utredning enligt Skollagen initieras. Allokera resurser för intensivt mentorstöd.',
      severity: 'critical',
      category: 'action',
      role: 'rektor',
    });
  }

  if (tier === 4) {
    recs.push({
      text: 'Daglig kontakt med eleven och nära kontakt med hemmet. Om eleven inte kommer till skolan — överväg hembesök.',
      severity: 'critical',
      category: 'action',
      role: 'mentor',
    });
    recs.push({
      text: 'Leda ärendet som case manager. Samordna med socialtjänst, BUP och primärvård. Överväg anpassat schema (gradvis återintroduktion, börja med 1 timme/dag).',
      severity: 'critical',
      category: 'action',
      role: 'elevhalsa',
    });
    recs.push({
      text: 'Säkerställ orosanmälan vid misstanke om att eleven far illa. Informera hemkommun om annan huvudman. Dokumentera alla åtgärder för Skolinspektionen.',
      severity: 'critical',
      category: 'action',
      role: 'rektor',
    });
    recs.push({
      text: 'Överväg alternativa utbildningsvägar: hemundervisning, distansundervisning, anpassad studiegång.',
      severity: 'critical',
      category: 'action',
      role: 'rektor',
    });
  }

  // ── Study plan analysis (from counseling data) ──────────────────────────

  const counseling = (data.counselingData ?? []).find(
    (c) => c.studentName === studentName
  );

  if (counseling) {
    // Extended program + struggling = recommend reducing load
    if (counseling.totalPoints > 2500 && tier >= 2) {
      const extraPoints = counseling.totalPoints - 2500;
      recs.push({
        text: `Eleven har ett utökat program (${counseling.totalPoints}p, ${extraPoints}p utöver standard). Med nuvarande frånvaro (${totalPct}%) rekommenderas att se över studieplanen — överväg att ta bort tillagda kurser för att minska belastningen och fokusera på kärnkurserna.`,
        severity: tier >= 3 ? 'critical' : 'warning',
        category: 'action',
        role: 'mentor',
      });
    }

    // Extended program + F grades = strong recommendation to reduce
    if (counseling.totalPoints > 2500 && counseling.failedPoints > 0) {
      recs.push({
        text: `Eleven har ${counseling.failedPoints}p F-betyg OCH ett utökat program. Rekommendation: Boka SYV-samtal för att revidera studieplanen — ta bort utökade kurser och prioritera godkänt i kärnkurser.`,
        severity: 'critical',
        category: 'action',
        role: 'mentor',
      });
    }

    // Graduation at risk
    if (counseling.graduationAtRisk) {
      const programLabel = counseling.programType === 'hogskoleforberedande'
        ? 'högskoleförberedande program (max 250p F)'
        : counseling.programType === 'yrkesprogram'
          ? 'yrkesprogram (max 500p F)'
          : 'program';
      recs.push({
        text: `Eleven har ${counseling.failedPoints}p F-betyg av maximalt ${counseling.maxAllowedF}p tillåtna för ${programLabel}. Marginal: ${counseling.fPointsRemaining}p. Utan förbättring riskerar eleven att inte erhålla gymnasieexamen utan istället få studiebevis.`,
        severity: 'critical',
        category: 'action',
        role: 'mentor',
      });
    }

    // High F points but not yet at risk (early warning)
    if (!counseling.graduationAtRisk && counseling.failedPoints > 0 && counseling.fPointsRemaining < counseling.maxAllowedF * 0.5) {
      recs.push({
        text: `Eleven har använt ${Math.round((counseling.failedPoints / counseling.maxAllowedF) * 100)}% av tillåtna F-poäng (${counseling.failedPoints}/${counseling.maxAllowedF}p). Säkerställ att pågående kurser prioriteras för godkänt resultat.`,
        severity: 'warning',
        category: 'insight',
        role: 'mentor',
      });
    }

    // Course warnings (uppmärksammande)
    if (counseling.warnings > 0) {
      recs.push({
        text: `Eleven har uppmärksammats i ${counseling.warnings} kurs${counseling.warnings > 1 ? 'er' : ''}. Koordinera med berörda ämneslärare för att identifiera gemensamma mönster och samordna insatser.`,
        severity: counseling.warnings >= 3 ? 'warning' : 'info',
        category: 'insight',
        role: 'mentor',
      });
    }

    // Late assignments (informational, may not be accurate)
    if (counseling.lateAssignments >= 5) {
      recs.push({
        text: `Eleven har ${counseling.lateAssignments} sena uppgifter${counseling.failedAssignments > 0 ? ` och ${counseling.failedAssignments} underkända` : ''}. Undersök om frånvaron leder till utebliven inlämning — överväg förlängda deadlines eller stödundervisning.`,
        severity: counseling.lateAssignments >= 10 ? 'warning' : 'info',
        category: 'insight',
        role: 'teacher',
      });
    }
  }

  // ── Positive insights ────────────────────────────────────────────────────

  if (tier === 1) {
    recs.push({
      text: `Elevens närvaro är god (${totalPct}%). Fortsätt med universella förebyggande insatser.`,
      severity: 'info',
      category: 'insight',
      role: 'all',
    });
  }

  return { tier, tierLabel, recommendations: recs };
}

/** Grade order for sorting: A=0 (first), F=5 (last) */
const GRADE_ORDER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 };

/** Builds the grades section HTML for a single student's report card. */
function renderReportCardGrades(studentName: string): string {
  const studentGrades = data.grades.filter((g) => g.studentName === studentName);

  const header = (count: number) =>
    `<h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim)">Betyg (${count} kurser)</h4>`;

  if (studentGrades.length === 0) {
    return `
      <div class="report-section" style="margin-bottom:18px">
        ${header(0)}
        <span style="font-size:12px;color:var(--text-dim)">Inga betyg registrerade</span>
      </div>
    `;
  }

  // Sort by grade value (A first, F last; unknowns at end)
  const sorted = [...studentGrades].sort((a, b) => {
    const ao = GRADE_ORDER[a.value.toUpperCase()] ?? 99;
    const bo = GRADE_ORDER[b.value.toUpperCase()] ?? 99;
    return ao - bo;
  });

  const gradeRows = sorted.map((g) => {
    const v = g.value.toUpperCase();
    return `
      <tr>
        <td style="padding:5px 8px;font-size:12px;color:var(--text-secondary)">${esc(g.courseName)}</td>
        <td style="padding:5px 8px;text-align:right">
          <span class="grade grade-${v}" style="font-size:12px;padding:2px 7px">${esc(g.value)}</span>
        </td>
      </tr>
    `;
  }).join('');

  // Mini summary: count per grade level
  const countByGrade = new Map<string, number>();
  for (const g of studentGrades) {
    const v = g.value.toUpperCase();
    countByGrade.set(v, (countByGrade.get(v) ?? 0) + 1);
  }
  const summaryParts = ['A', 'B', 'C', 'D', 'E', 'F']
    .filter((v) => countByGrade.has(v))
    .map((v) => `${countByGrade.get(v)}×${v}`);
  const summaryText = summaryParts.join(', ');

  return `
    <div class="report-section" style="margin-bottom:18px">
      ${header(studentGrades.length)}
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:1px solid var(--border-subtle)">
              <th style="padding:4px 8px;font-size:11px;color:var(--text-dim);text-align:left;font-weight:500">Kurs</th>
              <th style="padding:4px 8px;font-size:11px;color:var(--text-dim);text-align:right;font-weight:500">Betyg</th>
            </tr>
          </thead>
          <tbody>${gradeRows}</tbody>
        </table>
      </div>
      <div style="margin-top:8px;font-size:11px;color:var(--text-dim)">${esc(summaryText)}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Absence heatmap (GitHub-style calendar)
// ---------------------------------------------------------------------------

function renderAbsenceHeatmap(studentName: string): string {
  const studentRecords = data.absenceRecords.filter((r) => r.studentName === studentName);

  // Build a map of date → { hasAbsence, isExcused, totalMinutes }
  const dateMap = new Map<string, { totalMinutes: number; isExcused: boolean }>();
  for (const r of studentRecords) {
    const existing = dateMap.get(r.date);
    const totalMinutes = (existing?.totalMinutes ?? 0) + r.totalAbsenceMinutes;
    // Excused only if ALL absence on that day is excused
    const isExcused = existing ? (existing.isExcused && r.isExcused) : r.isExcused;
    dateMap.set(r.date, { totalMinutes, isExcused });
  }

  // School year: from Aug 15 of the current school year start to today
  const today = new Date();
  const schoolYearStartYear = today.getMonth() >= 7 ? today.getFullYear() : today.getFullYear() - 1;
  const startDate = new Date(schoolYearStartYear, 7, 15); // Aug 15
  const endDate = today;

  // Generate all school day dates (Mon–Fri)
  interface CalCell { date: string; dayOfWeek: number; isWeekend: boolean }
  const allDays: CalCell[] = [];
  const cur = new Date(startDate);
  while (cur <= endDate) {
    const dow = cur.getDay(); // 0=Sun
    allDays.push({
      date: cur.toISOString().split('T')[0],
      dayOfWeek: dow,
      isWeekend: dow === 0 || dow === 6,
    });
    cur.setDate(cur.getDate() + 1);
  }

  const schoolDays = allDays.filter((d) => !d.isWeekend);
  if (schoolDays.length === 0) return '';

  // Group by week (ISO week number approximation: group by Sunday-start week)
  const weekGroups = new Map<string, CalCell[]>();
  for (const day of schoolDays) {
    const d = new Date(day.date);
    // Find the Monday of this week
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const weekKey = monday.toISOString().split('T')[0];
    const list = weekGroups.get(weekKey) ?? [];
    list.push(day);
    weekGroups.set(weekKey, list);
  }

  // Month labels: find first week that contains each month
  const monthLabels = new Map<string, string>(); // weekKey → month name
  const MONTHS_SV = ['Jan', 'Feb', 'Mar', 'Apr', 'Maj', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec'];
  let lastMonth = -1;
  for (const [weekKey, days] of weekGroups) {
    const d = new Date(days[0].date);
    const m = d.getMonth();
    if (m !== lastMonth) {
      monthLabels.set(weekKey, MONTHS_SV[m]);
      lastMonth = m;
    }
  }

  // Cell color function
  function cellColor(date: string): string {
    const entry = dateMap.get(date);
    if (!entry) return 'var(--bg-elevated)'; // No data
    if (entry.isExcused) return '#4F6A8C80'; // Blue tint — excused
    const mins = entry.totalMinutes;
    if (mins >= 60) return '#c0392b'; // Dark red — full/heavy absence
    if (mins >= 20) return '#e67e72'; // Light red — partial absence
    return '#f4b8b5'; // Very light red — minimal absence
  }

  const weekKeys = [...weekGroups.keys()];
  const DAY_LABELS = ['M', 'T', 'O', 'T', 'F']; // Mon–Fri

  // Build header row (month labels)
  const monthHeaderCells = weekKeys.map((wk) => {
    const label = monthLabels.get(wk) ?? '';
    return `<td style="font-size:10px;color:var(--text-dim);text-align:left;padding:0 1px;white-space:nowrap">${label}</td>`;
  }).join('');

  // Build day rows (Mon=0 … Fri=4)
  const dayRows = [0, 1, 2, 3, 4].map((dow) => {
    const cells = weekKeys.map((wk) => {
      const days = weekGroups.get(wk) ?? [];
      // dow 0=Mon…4=Fri, JS getDay: Mon=1…Fri=5
      const jsDay = dow + 1;
      const day = days.find((d) => new Date(d.date).getDay() === jsDay);
      if (!day) {
        return `<td style="width:12px;height:12px"></td>`;
      }
      const color = cellColor(day.date);
      const entry = dateMap.get(day.date);
      const tooltip = entry
        ? `${day.date}: ${entry.totalMinutes} min ${entry.isExcused ? '(anmäld)' : '(oanmäld)'}`
        : day.date;
      return `<td title="${tooltip}" style="width:12px;height:12px;background:${color};border-radius:2px;cursor:default"></td>`;
    }).join('');
    return `
      <tr>
        <td style="font-size:10px;color:var(--text-dim);padding-right:4px;white-space:nowrap">${DAY_LABELS[dow]}</td>
        ${cells}
      </tr>
    `;
  }).join('');

  return `
    <div style="overflow-x:auto;padding:4px 0">
      <table style="border-collapse:separate;border-spacing:2px">
        <thead>
          <tr>
            <td style="width:16px"></td>
            ${monthHeaderCells}
          </tr>
        </thead>
        <tbody>${dayRows}</tbody>
      </table>
      <div style="display:flex;gap:12px;margin-top:6px;font-size:11px;color:var(--text-dim);flex-wrap:wrap">
        <span><span style="display:inline-block;width:10px;height:10px;background:var(--bg-elevated);border-radius:2px;margin-right:3px"></span>Ingen frånvaro</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#f4b8b5;border-radius:2px;margin-right:3px"></span>Liten frånvaro</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#e67e72;border-radius:2px;margin-right:3px"></span>Delvis frånvaro</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#c0392b;border-radius:2px;margin-right:3px"></span>Stor frånvaro</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#4F6A8C80;border-radius:2px;margin-right:3px"></span>Anmäld frånvaro</span>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Guardian contact section
// ---------------------------------------------------------------------------

function renderGuardianContact(studentName: string): string {
  const student = data.students.find((s) => s.name === studentName);
  const studentSummary = data.studentSummaries.find((s) => s.studentName === studentName);
  const studentGuardians = guardianCache.filter((g: Guardian) => g.studentName === studentName);

  const absencePct = studentSummary?.totalAbsencePercent ?? 0;
  const firstName = studentName.split(/\s+/)[0] ?? studentName;

  // Detect day pattern for message template
  const records = recordsByStudent().get(studentName) ?? [];
  const dayCount = Array<number>(5).fill(0);
  for (const r of records) {
    if (r.dayOfWeek >= 0 && r.dayOfWeek <= 4) dayCount[r.dayOfWeek]++;
  }
  const maxDayCount = Math.max(...dayCount);
  let patternLine = '';
  if (maxDayCount > 0) {
    const dominantDays = DAY_NAMES.slice(0, 5).filter((_, i) => dayCount[i] === maxDayCount);
    if (dominantDays.length > 0 && maxDayCount >= 3) {
      patternLine = `Frånvaron sker främst på ${dominantDays.map((d) => d.toLowerCase() + 'ar').join(' och ')}.`;
    }
  }

  const schoolName = data.schoolInfo?.slug ?? '[Skolans namn]';

  if (student?.isOver18) {
    return `
      <div class="report-section" style="margin-bottom:18px">
        <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim)">Kontakt med vårdnadshavare</h4>
        <div style="padding:10px 12px;background:#4F6A8C18;border-radius:6px;border-left:3px solid #4F6A8C;font-size:13px;color:var(--text-secondary);line-height:1.5">
          Eleven är myndig (18+). Kontakt ska riktas direkt till eleven om inte samtycke getts för vårdnadshavarkontakt.
        </div>
      </div>
    `;
  }

  if (studentGuardians.length === 0) {
    return `
      <div class="report-section" style="margin-bottom:18px">
        <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim)">Kontakt med vårdnadshavare</h4>
        <span style="font-size:12px;color:var(--text-dim)">Ingen vårdnadshavardata tillgänglig</span>
      </div>
    `;
  }

  const guardianCards = studentGuardians.map((g: Guardian, idx: number) => {
    const msgId = `guardian-msg-${studentName.replace(/[^a-zA-Z0-9]/g, '_')}-${idx}`;
    const btnId = `guardian-btn-${studentName.replace(/[^a-zA-Z0-9]/g, '_')}-${idx}`;

    const message = [
      `Hej ${g.guardianName},`,
      '',
      `Vi vill informera er om att ${studentName} har haft en total frånvaro på ${absencePct}% de senaste två månaderna.`,
      patternLine,
      '',
      `Vi skulle gärna vilja boka ett samtal med er för att diskutera hur vi bäst kan stödja ${firstName}s närvaro.`,
      '',
      'Vänliga hälsningar,',
      '[Ditt namn]',
      schoolName,
    ].filter((line) => line !== undefined).join('\n');

    const contactInfo = [
      g.mobile ? `📱 ${g.mobile}` : '',
      g.homePhone ? `☎ ${g.homePhone}` : '',
      g.workPhone ? `💼 ${g.workPhone}` : '',
      g.email ? `✉ ${g.email}` : '',
    ].filter(Boolean).join('  ');

    return `
      <div style="padding:10px 12px;background:var(--bg-elevated);border-radius:6px;margin-bottom:8px">
        <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:4px">${esc(g.guardianName)}</div>
        ${contactInfo ? `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">${esc(contactInfo)}</div>` : ''}
        <textarea id="${msgId}" readonly style="
          width:100%;box-sizing:border-box;
          background:var(--bg-card);border:1px solid var(--border);border-radius:4px;
          padding:8px;font-size:12px;color:var(--text-secondary);font-family:var(--font);
          resize:vertical;min-height:120px;
        ">${esc(message)}</textarea>
        <button id="${btnId}" style="
          margin-top:6px;padding:5px 14px;font-size:12px;font-family:var(--font);
          background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border);
          border-radius:5px;cursor:pointer
        ">Kopiera meddelande</button>
      </div>
    `;
  }).join('');

  return `
    <div class="report-section" style="margin-bottom:18px">
      <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim)">Kontakt med vårdnadshavare</h4>
      ${guardianCards}
    </div>
  `;
}

/** Attach copy-to-clipboard handlers for guardian message buttons. Call after HTML is in DOM. */
function attachGuardianCopyHandlers(studentName: string): void {
  const guardians = guardianCache.filter((g: Guardian) => g.studentName === studentName);
  guardians.forEach((_g: Guardian, idx: number) => {
    const safeName = studentName.replace(/[^a-zA-Z0-9]/g, '_');
    const msgId = `guardian-msg-${safeName}-${idx}`;
    const btnId = `guardian-btn-${safeName}-${idx}`;
    const btn = document.getElementById(btnId) as HTMLButtonElement | null;
    const textarea = document.getElementById(msgId) as HTMLTextAreaElement | null;
    if (btn && textarea) {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(textarea.value).then(() => {
          btn.textContent = 'Kopierat!';
          setTimeout(() => { btn.textContent = 'Kopiera meddelande'; }, 2000);
        }).catch(() => {
          // Fallback: select text
          textarea.select();
        });
      });
    }
  });
}

// ---------------------------------------------------------------------------
// CICO tracker template
// ---------------------------------------------------------------------------

function renderCICOTracker(studentName: string): string {
  const today = new Date();
  // ISO week number
  const startOfYear = new Date(today.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((today.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
  const student = data.students.find((s) => s.name === studentName);
  const className = data.studentSummaries.find((s) => s.studentName === studentName)?.className ?? '';

  const cellStyle = 'padding:8px 6px;border:1px solid var(--border-subtle);font-size:12px;vertical-align:top';
  const dayRows = ['Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag'].map((day) => `
    <tr>
      <td style="${cellStyle};font-weight:600;color:var(--text-secondary);white-space:nowrap">${day}</td>
      <td style="${cellStyle};width:50px">
        <div style="width:20px;height:20px;border:2px solid var(--border);border-radius:3px;display:inline-block"></div>
      </td>
      <td style="${cellStyle}">
        <div style="height:2px;background:var(--border-subtle);margin:6px 0"></div>
        <div style="height:2px;background:var(--border-subtle);margin:6px 0"></div>
      </td>
      <td style="${cellStyle};width:50px">
        <div style="width:20px;height:20px;border:2px solid var(--border);border-radius:3px;display:inline-block"></div>
      </td>
      <td style="${cellStyle}">
        <div style="height:2px;background:var(--border-subtle);margin:6px 0"></div>
        <div style="height:2px;background:var(--border-subtle);margin:6px 0"></div>
      </td>
    </tr>
  `).join('');

  return `
    <div style="padding:12px 14px;background:var(--bg-elevated);border-radius:6px;overflow:hidden;max-width:100%;box-sizing:border-box">
      <div style="margin-bottom:10px;font-size:12px;color:var(--text-secondary)">
        <strong>Elev:</strong> ${esc(studentName)}
        ${className ? ` &nbsp;|&nbsp; <strong>Klass:</strong> ${esc(className)}` : ''}
        &nbsp;|&nbsp; <strong>Vecka:</strong> ${weekNum}
      </div>
      <div style="overflow-x:auto;max-width:100%">
        <table style="width:100%;border-collapse:collapse;table-layout:fixed">
          <thead>
            <tr style="background:var(--bg-card)">
              <th style="${cellStyle};text-align:left">Dag</th>
              <th style="${cellStyle};text-align:center">Morgon<br><small style="font-weight:400;color:var(--text-dim)">Incheckning</small></th>
              <th style="${cellStyle};text-align:left">Mål för dagen</th>
              <th style="${cellStyle};text-align:center">Eftermiddag<br><small style="font-weight:400;color:var(--text-dim)">Utcheckning</small></th>
              <th style="${cellStyle};text-align:left">Kommentar</th>
            </tr>
          </thead>
          <tbody>${dayRows}</tbody>
        </table>
      </div>
      <button onclick="window.print()" style="
        margin-top:10px;padding:6px 16px;font-size:12px;font-family:var(--font);
        background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border);
        border-radius:5px;cursor:pointer
      ">Skriv ut CICO</button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Studiesituation section (counseling data for a single student)
// ---------------------------------------------------------------------------

function renderStudiesituation(studentName: string): string {
  const counseling = (data.counselingData ?? []).find(
    (c: StudentCounselingData) => c.studentName === studentName,
  );
  if (!counseling) return '';

  // Color for the fPointsRemaining cell
  const marginColor = counseling.fPointsRemaining > 150
    ? '#27ae60'
    : counseling.fPointsRemaining >= 50
    ? '#d4a017'
    : '#c0392b';

  const marginBg = counseling.fPointsRemaining > 150
    ? '#27ae6018'
    : counseling.fPointsRemaining >= 50
    ? '#d4a01718'
    : '#c0392b18';

  const graduationStatus = counseling.graduationAtRisk
    ? `<span style="color:#c0392b;font-weight:600">&#9888; Risk</span>`
    : `<span style="color:#27ae60;font-weight:600">&#10003; Möjlig</span>`;

  const atRiskBanner = counseling.graduationAtRisk ? `
    <div style="
      margin-top:10px;padding:10px 12px;
      background:#c0392b18;border-radius:6px;border-left:3px solid #c0392b;
      font-size:13px;color:var(--text-secondary);line-height:1.5;font-weight:500
    ">
      &#9888;&#65039; Eleven riskerar att inte erhålla gymnasieexamen.
      Nuvarande F-poäng: <strong style="color:#c0392b">${counseling.failedPoints}</strong>
      av maximalt <strong>${counseling.maxAllowedF}</strong>.
    </div>
  ` : '';

  const warnings = [];
  if (counseling.lateAssignments > 0) {
    warnings.push(`&#9888; ${counseling.lateAssignments} sena uppgifter`);
  }
  if (counseling.failedAssignments > 0) {
    warnings.push(`&#9888; ${counseling.failedAssignments} underkända uppgifter`);
  }
  if (counseling.warnings > 0) {
    warnings.push(`&#9888; Uppmärksammad i ${counseling.warnings} kurser`);
  }

  const warningsHtml = warnings.length > 0 ? `
    <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">
      ${warnings.map((w) => `
        <span style="font-size:12px;background:#d4a01720;color:#d4a017;border:1px solid #d4a01740;padding:2px 8px;border-radius:4px">${w}</span>
      `).join('')}
    </div>
  ` : '';

  return `
    <div class="report-section" style="margin-bottom:18px">
      <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim)">Studiesituation</h4>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;border:1px solid var(--border);border-radius:6px;overflow:hidden">
          <thead>
            <tr style="background:var(--bg-elevated)">
              <th style="padding:6px 10px;font-size:11px;color:var(--text-dim);font-weight:500;text-align:center;border-bottom:1px solid var(--border)">Poäng F</th>
              <th style="padding:6px 10px;font-size:11px;color:var(--text-dim);font-weight:500;text-align:center;border-bottom:1px solid var(--border)">Max F</th>
              <th style="padding:6px 10px;font-size:11px;color:var(--text-dim);font-weight:500;text-align:center;border-bottom:1px solid var(--border)">Marginal</th>
              <th style="padding:6px 10px;font-size:11px;color:var(--text-dim);font-weight:500;text-align:center;border-bottom:1px solid var(--border)">Examen</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style="padding:8px 10px;text-align:center;font-size:14px;font-weight:700;font-variant-numeric:tabular-nums;color:#c0392b">${counseling.failedPoints}</td>
              <td style="padding:8px 10px;text-align:center;font-size:14px;font-variant-numeric:tabular-nums;color:var(--text-secondary)">${counseling.maxAllowedF}</td>
              <td style="padding:8px 10px;text-align:center;font-size:14px;font-weight:700;font-variant-numeric:tabular-nums;color:${marginColor};background:${marginBg}">${counseling.fPointsRemaining}p</td>
              <td style="padding:8px 10px;text-align:center;font-size:13px">${graduationStatus}</td>
            </tr>
          </tbody>
        </table>
      </div>
      ${warningsHtml}
      ${atRiskBanner}
    </div>
  `;
}

function renderReportCard(studentName: string): string {
  const summary = data.studentSummaries.find((s) => s.studentName === studentName);
  if (!summary) return '<p style="color:var(--text-dim)">Eleven hittades inte.</p>';

  const records = recordsByStudent().get(studentName) ?? [];
  const recSet = generateRecommendations(studentName);

  // Avatar: initials from first + last name
  const nameParts = studentName.trim().split(/\s+/);
  const initials = nameParts.length >= 2
    ? (nameParts[0][0] + nameParts[nameParts.length - 1][0]).toUpperCase()
    : nameParts[0].slice(0, 2).toUpperCase();

  // Scheduled hours
  const schedHours = Math.round(summary.totalScheduledMinutes / 60 * 10) / 10;

  // HT vs VT comparison
  const htPeriod = getPeriod('ht');
  const vtPeriod = getPeriod('vt');
  const htS = htPeriod?.summaries.find((s) => s.studentName === studentName);
  const vtS = vtPeriod?.summaries.find((s) => s.studentName === studentName);

  let htVtSection = '';
  if (htS && vtS) {
    const diff = vtS.totalAbsencePercent - htS.totalAbsencePercent;
    const trendArrow = diff > 5 ? '&#8679;' : diff < -5 ? '&#8681;' : '&#8596;';
    const trendClass = diff > 5 ? 'report-trend-up' : diff < -5 ? 'report-trend-down' : 'report-trend-stable';
    const trendColor = diff > 5 ? '#c0392b' : diff < -5 ? '#27ae60' : 'var(--text-dim)';
    htVtSection = `
      <div class="report-section">
        <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim)">HT vs VT</h4>
        <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
          <span style="font-size:13px;color:var(--text-secondary)">
            HT: <strong style="color:${pctColor(htS.totalAbsencePercent)}">${htS.totalAbsencePercent}%</strong>
          </span>
          <span style="font-size:16px;color:${trendColor}" class="${trendClass}">${trendArrow}</span>
          <span style="font-size:13px;color:var(--text-secondary)">
            VT: <strong style="color:${pctColor(vtS.totalAbsencePercent)}">${vtS.totalAbsencePercent}%</strong>
          </span>
          <span style="font-size:12px;color:${trendColor};font-variant-numeric:tabular-nums">
            ${diff > 0 ? '+' : ''}${diff}%
          </span>
        </div>
      </div>
    `;
  }

  // Day-of-week pattern (mini bars, Mon–Fri)
  const dayMinsArr = Array<number>(5).fill(0);
  for (const r of records) {
    if (r.dayOfWeek >= 0 && r.dayOfWeek <= 4) {
      dayMinsArr[r.dayOfWeek] += r.totalAbsenceMinutes;
    }
  }
  const maxDayMin = Math.max(...dayMinsArr, 1);
  const dayBars = DAY_SHORT.slice(0, 5).map((label, i) => {
    const h = Math.round(dayMinsArr[i] / 60 * 10) / 10;
    const widthPct = Math.min(100, (dayMinsArr[i] / maxDayMin) * 100);
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:2px 0">
        <span style="font-size:11px;color:var(--text-muted);min-width:28px">${label}</span>
        <div class="att-bar-track" style="flex:1">
          <div class="att-bar-fill" style="width:${widthPct}%;background:${pctColor(summary.totalAbsencePercent)}"></div>
        </div>
        <span style="font-size:11px;font-variant-numeric:tabular-nums;color:var(--text-dim);min-width:30px;text-align:right">
          ${dayMinsArr[i] > 0 ? h + ' h' : '—'}
        </span>
      </div>
    `;
  }).join('');

  // Course breakdown table
  const byCourse = new Map<string, { total: number; count: number }>();
  for (const r of records) {
    const entry = byCourse.get(r.courseName) ?? { total: 0, count: 0 };
    byCourse.set(r.courseName, { total: entry.total + r.totalAbsenceMinutes, count: entry.count + 1 });
  }
  const courseRows = [...byCourse.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([course, stats]) => `
      <tr>
        <td style="padding:5px 8px;font-size:12px;color:var(--text-secondary)">${esc(course)}</td>
        <td style="padding:5px 8px;font-size:12px;font-variant-numeric:tabular-nums;text-align:right">${fmtMinutes(stats.total)}</td>
        <td style="padding:5px 8px;font-size:11px;color:var(--text-dim);text-align:right">${stats.count} lekt.</td>
      </tr>
    `).join('');

  // Recommendations section
  const tierBgColor = recSet.tier >= 3 ? '#c0392b' : recSet.tier === 2 ? '#d4a017' : '#27ae60';

  const severityBorderColor = (s: Recommendation['severity']) =>
    s === 'critical' ? '#c0392b' : s === 'warning' ? '#d4a017' : '#4F6A8C';

  const roleLabel: Record<Recommendation['role'], string> = {
    mentor: 'Rekommendationer för mentor',
    teacher: 'Rekommendationer för ämneslärare',
    elevhalsa: 'Rekommendationer för elevhälsoteam',
    rektor: 'Rekommendationer för rektor',
    all: 'Generella rekommendationer',
  };
  const roleIcon: Record<Recommendation['role'], string> = {
    mentor: '&#128101;',
    teacher: '&#128218;',
    elevhalsa: '&#129657;',
    rektor: '&#127963;',
    all: '&#128203;',
  };

  const renderRecCard = (rec: Recommendation) => `
    <div class="report-insight" style="
      padding:9px 12px;margin-bottom:6px;
      background:var(--bg-elevated);border-radius:6px;
      border-left:3px solid ${severityBorderColor(rec.severity)};
      font-size:13px;color:var(--text-secondary);line-height:1.5
    ">${esc(rec.text)}</div>
  `;

  // Legal alerts first
  const legalRecs = recSet.recommendations.filter((r) => r.category === 'legal');
  const legalSection = legalRecs.length > 0 ? `
    <div style="margin-bottom:14px">
      ${legalRecs.map((r) => `
        <div style="
          padding:10px 13px;margin-bottom:6px;
          background:#c0392b18;border-radius:6px;border-left:3px solid #c0392b;
          font-size:13px;color:var(--text-secondary);line-height:1.5;font-weight:500
        ">&#9888;&#65039; ${esc(r.text)}</div>
      `).join('')}
    </div>
  ` : '';

  // Group non-legal recs by role, preserving display order
  const roleOrder: Recommendation['role'][] = ['mentor', 'teacher', 'elevhalsa', 'rektor', 'all'];
  const nonLegalRecs = recSet.recommendations.filter((r) => r.category !== 'legal');
  const groupedSections = roleOrder.map((role) => {
    const group = nonLegalRecs.filter((r) => r.role === role);
    if (group.length === 0) return '';
    return `
      <div style="margin-bottom:16px">
        <h5 style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim)">
          ${roleIcon[role]} ${roleLabel[role]}
        </h5>
        ${group.map(renderRecCard).join('')}
      </div>
    `;
  }).join('');

  // Unique IDs for collapsible sections
  const safeStudentName = studentName.replace(/[^a-zA-Z0-9]/g, '_');
  const heatmapId = `heatmap-content-${safeStudentName}`;
  const heatmapBtnId = `heatmap-btn-${safeStudentName}`;
  const cicoId = `cico-content-${safeStudentName}`;
  const cicoBtnId = `cico-btn-${safeStudentName}`;

  const toggleBtnStyle = `
    padding:4px 12px;font-size:12px;font-family:var(--font);
    background:var(--bg-elevated);color:var(--text-secondary);border:1px solid var(--border);
    border-radius:5px;cursor:pointer;margin-bottom:6px
  `;

  return `
    <div class="report-card" style="
      background:var(--bg-card);border:1px solid var(--border);border-radius:10px;
      padding:20px;margin-bottom:20px
    ">
      <!-- Header -->
      <div class="report-header" style="display:flex;align-items:center;gap:14px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border-subtle)">
        <div id="report-avatar" class="report-avatar" style="
          width:48px;height:48px;border-radius:50%;background:${summary.isFlagged ? '#c0392b' : '#384A66'};
          display:flex;align-items:center;justify-content:center;
          font-size:16px;font-weight:700;color:#fff;flex-shrink:0;letter-spacing:.02em;overflow:hidden
        ">${esc(initials)}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span class="report-name" style="font-size:16px;font-weight:700;color:var(--text-primary)">${esc(summary.studentName)}</span>
            ${summary.isFlagged
              ? `<span class="report-flag grade-badge" style="background:#c0392b20;color:#c0392b;border:1px solid #c0392b40;font-size:10px;padding:2px 6px">FLAGGAD</span>`
              : ''}
          </div>
          ${summary.className
            ? `<div class="report-class" style="font-size:12px;color:var(--text-dim);margin-top:2px">${esc(summary.className)}</div>`
            : ''}
        </div>
        <button onclick="window.print()" style="
          flex-shrink:0;padding:6px 14px;font-size:12px;font-family:var(--font);
          background:var(--bg-elevated);color:var(--text-secondary);border:1px solid var(--border);
          border-radius:6px;cursor:pointer;white-space:nowrap
        ">Skriv ut</button>
      </div>

      <!-- Metric cards -->
      <div class="report-metrics" style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px">
        <div class="report-metric" style="background:var(--bg-elevated);border-radius:8px;padding:12px 10px;text-align:center">
          <div class="report-metric-value" style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;color:${pctColor(summary.totalAbsencePercent)}">${summary.totalAbsencePercent}%</div>
          <div class="report-metric-label" style="font-size:11px;color:var(--text-dim);margin-top:3px">Total frånvaro</div>
        </div>
        <div class="report-metric" style="background:var(--bg-elevated);border-radius:8px;padding:12px 10px;text-align:center">
          <div class="report-metric-value" style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;color:#c0392b">${summary.unexcusedPercent}%</div>
          <div class="report-metric-label" style="font-size:11px;color:var(--text-dim);margin-top:3px">Oanmäld</div>
        </div>
        <div class="report-metric" style="background:var(--bg-elevated);border-radius:8px;padding:12px 10px;text-align:center">
          <div class="report-metric-value" style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;color:#27ae60">${summary.excusedPercent}%</div>
          <div class="report-metric-label" style="font-size:11px;color:var(--text-dim);margin-top:3px">Anmäld</div>
        </div>
        <div class="report-metric" style="background:var(--bg-elevated);border-radius:8px;padding:12px 10px;text-align:center">
          <div class="report-metric-value" style="font-size:20px;font-weight:700;color:var(--blue-600)">${(() => { const m = calculateMerit(studentName); return m ? m.merit.toFixed(1) : '-'; })()}</div>
          <div class="report-metric-label" style="font-size:11px;color:var(--text-dim);margin-top:3px">Meritvärde (${(() => { const m = calculateMerit(studentName); return m ? m.totalCredits + 'p' : '-'; })()})</div>
        </div>
      </div>

      <!-- 2-column main content grid -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px">
        <!-- Left column: data -->
        <div>
          <!-- HT vs VT comparison -->
          ${htVtSection}

          <!-- Day-of-week pattern -->
          <div class="report-section" style="margin-bottom:18px">
            <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim)">Frånvaro per veckodag</h4>
            ${records.length > 0
              ? dayBars
              : '<span style="font-size:12px;color:var(--text-dim)">Ingen detaljdata</span>'}
          </div>

          <!-- Course breakdown -->
          <div class="report-section" style="margin-bottom:18px">
            <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim)">Frånvaro per kurs</h4>
            ${records.length > 0
              ? `<div style="overflow-x:auto">
                  <table style="width:100%;border-collapse:collapse">
                    <thead>
                      <tr style="border-bottom:1px solid var(--border-subtle)">
                        <th style="padding:4px 8px;font-size:11px;color:var(--text-dim);text-align:left;font-weight:500">Kurs</th>
                        <th style="padding:4px 8px;font-size:11px;color:var(--text-dim);text-align:right;font-weight:500">Frånvaro</th>
                        <th style="padding:4px 8px;font-size:11px;color:var(--text-dim);text-align:right;font-weight:500">Tillfällen</th>
                      </tr>
                    </thead>
                    <tbody>${courseRows}</tbody>
                  </table>
                </div>`
              : '<span style="font-size:12px;color:var(--text-dim)">Ingen detaljdata</span>'}
          </div>

          <!-- Grades section -->
          ${renderReportCardGrades(studentName)}

          <!-- Studiesituation (counseling data) -->
          ${renderStudiesituation(studentName)}
        </div>

        <!-- Right column: actions -->
        <div>
          <!-- Recommendations section -->
          <div class="report-section" style="margin-bottom:18px">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
              <h4 style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim)">Rekommendationer</h4>
              <span style="
                display:inline-block;padding:3px 10px;border-radius:12px;
                background:${tierBgColor}20;color:${tierBgColor};
                border:1px solid ${tierBgColor}50;font-size:11px;font-weight:600;letter-spacing:.02em
              ">Nivå ${recSet.tier}: ${recSet.tierLabel}</span>
            </div>
            ${legalSection}
            ${groupedSections || '<span style="font-size:12px;color:var(--text-dim)">Inga rekommendationer tillgängliga.</span>'}
            <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border-subtle);font-size:11px;color:var(--text-dim);font-style:italic">
              Baserat på Skolverkets riktlinjer, Skollagen, och evidensbaserad forskning om skolfrånvaro.
            </div>
          </div>

          <!-- Guardian contact section -->
          ${renderGuardianContact(studentName)}

          <!-- CICO tracker (collapsible) -->
          <div class="report-section" style="margin-bottom:18px">
            <button id="${cicoBtnId}" style="${toggleBtnStyle}">Visa CICO-mall</button>
            <div id="${cicoId}" style="display:none">
              ${renderCICOTracker(studentName)}
            </div>
          </div>
        </div>
      </div>

      <!-- Absence heatmap (full width, collapsible) -->
      <div style="border-top:1px solid var(--border-subtle);padding-top:16px">
        <button id="${heatmapBtnId}" style="${toggleBtnStyle}">Visa frånvarokalender</button>
        <div id="${heatmapId}" style="display:none">
          <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim)">Frånvarokalender — innevarande läsår</h4>
          ${renderAbsenceHeatmap(studentName)}
        </div>
      </div>
    </div>
  `;
}

/** Attach toggle and clipboard handlers after a report card is injected into the DOM. */
function attachReportCardHandlers(studentName: string): void {
  const safeName = studentName.replace(/[^a-zA-Z0-9]/g, '_');

  const heatmapBtn = document.getElementById(`heatmap-btn-${safeName}`);
  const heatmapContent = document.getElementById(`heatmap-content-${safeName}`);
  if (heatmapBtn && heatmapContent) {
    heatmapBtn.addEventListener('click', () => {
      const isHidden = heatmapContent.style.display === 'none';
      heatmapContent.style.display = isHidden ? '' : 'none';
      heatmapBtn.textContent = isHidden ? 'Dölj frånvarokalender' : 'Visa frånvarokalender';
    });
  }

  const cicoBtn = document.getElementById(`cico-btn-${safeName}`);
  const cicoContent = document.getElementById(`cico-content-${safeName}`);
  if (cicoBtn && cicoContent) {
    cicoBtn.addEventListener('click', () => {
      const isHidden = cicoContent.style.display === 'none';
      cicoContent.style.display = isHidden ? '' : 'none';
      cicoBtn.textContent = isHidden ? 'Dölj CICO-mall' : 'Visa CICO-mall';
    });
  }

  attachGuardianCopyHandlers(studentName);
}

function renderReports(): void {
  destroyCharts();

  const summaries = sortedSummaries();

  if (summaries.length === 0) {
    main().innerHTML = renderEmpty(
      'Rapporter',
      '&#128203;',
      'Ingen frånvarodata insamlad',
      'Besök frånvarosidan i Progress. Data samlas in automatiskt.'
    );
    attachInlineFetch();
    return;
  }

  // If previously selected student no longer exists, clear selection
  if (selectedReportStudent && !summaries.find((s) => s.studentName === selectedReportStudent)) {
    selectedReportStudent = null;
  }

  // Build student selector list
  const studentItems = summaries.map((s) => {
    const isSelected = selectedReportStudent === s.studentName;
    return `
      <div data-report-student="${esc(s.studentName)}" style="
        display:flex;justify-content:space-between;align-items:center;
        padding:8px 10px;border-radius:6px;cursor:pointer;margin-bottom:2px;
        background:${isSelected ? 'var(--bg-elevated)' : 'transparent'};
        border:1px solid ${isSelected ? 'var(--border)' : 'transparent'};
        transition:background .1s
      ">
        <div>
          <span style="font-size:13px;font-weight:${isSelected ? '600' : '400'};color:var(--text-primary)">${esc(s.studentName)}</span>
          ${s.className ? `<span style="font-size:11px;color:var(--text-dim);margin-left:6px">${esc(s.className)}</span>` : ''}
        </div>
        <span style="font-size:12px;font-variant-numeric:tabular-nums;color:${pctColor(s.totalAbsencePercent)};flex-shrink:0;margin-left:8px">${s.totalAbsencePercent}%</span>
      </div>
    `;
  }).join('');

  const reportCardHtml = selectedReportStudent
    ? renderReportCard(selectedReportStudent)
    : `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:200px;color:var(--text-dim)">
        <div style="font-size:32px;margin-bottom:8px">&#128203;</div>
        <div style="font-size:14px">Välj en elev i listan</div>
      </div>`;

  main().innerHTML = `
    <h2 class="page-title">Rapporter</h2>
    <p class="page-subtitle">${summaries.length} elever — välj elev för att visa rapport</p>

    <div style="display:grid;grid-template-columns:280px 1fr;gap:16px;align-items:start">
      <!-- Student selector -->
      <div class="card" style="padding:12px;position:sticky;top:16px">
        <div style="margin-bottom:8px">
          <input id="report-search" type="text" placeholder="Sök elev..." style="
            background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;
            padding:6px 10px;color:var(--text-primary);font-size:12px;width:100%;box-sizing:border-box;
            font-family:var(--font);outline:none
          "/>
        </div>
        <div id="report-student-list" style="max-height:calc(100vh - 200px);overflow-y:auto">
          ${studentItems}
        </div>
      </div>

      <!-- Report card -->
      <div id="report-card-container">
        ${reportCardHtml}
      </div>
    </div>
  `;

  // Search filter
  document.getElementById('report-search')!.addEventListener('input', (e) => {
    const query = (e.target as HTMLInputElement).value.toLowerCase();
    document.querySelectorAll<HTMLElement>('#report-student-list [data-report-student]').forEach((el) => {
      const name = el.dataset.reportStudent ?? '';
      el.style.display = name.toLowerCase().includes(query) ? '' : 'none';
    });
  });

  // Student click handler — update selection and re-render card only
  document.querySelectorAll<HTMLElement>('#report-student-list [data-report-student]').forEach((el) => {
    el.addEventListener('click', () => {
      const name = el.dataset.reportStudent!;
      selectedReportStudent = name;

      // Update selected highlight without full re-render
      document.querySelectorAll<HTMLElement>('#report-student-list [data-report-student]').forEach((item) => {
        const isNow = item.dataset.reportStudent === name;
        item.style.background = isNow ? 'var(--bg-elevated)' : 'transparent';
        item.style.border = `1px solid ${isNow ? 'var(--border)' : 'transparent'}`;
        const nameSpan = item.querySelector('span') as HTMLElement | null;
        if (nameSpan) nameSpan.style.fontWeight = isNow ? '600' : '400';
      });

      // Re-render just the report card area
      const container = document.getElementById('report-card-container');
      if (container) container.innerHTML = renderReportCard(name);
      attachReportCardHandlers(name);
      tryLoadStudentPhoto(name);
    });
  });

  // Load photo and attach handlers for initially selected student
  if (selectedReportStudent) {
    attachReportCardHandlers(selectedReportStudent);
    tryLoadStudentPhoto(selectedReportStudent);
  }
}

/** Try to load a student's profile photo from Progress and inject into the avatar */
function tryLoadStudentPhoto(studentName: string): void {
  // Find the student ID from stored students
  const student = data.students.find((s) => s.name === studentName);
  const studentId = student?.id?.replace('name:', '');
  // Only fetch if we have a numeric ID (not a name: fallback)
  if (!studentId || !studentId.match(/^\d+$/)) return;

  chrome.runtime.sendMessage({ type: 'FETCH_PHOTO', studentId }, (resp: { photoUrl: string | null } | undefined) => {
    const photoUrl = resp?.photoUrl;
    if (!photoUrl) return;

    const avatarEl = document.getElementById('report-avatar');
    if (avatarEl) {
      avatarEl.innerHTML = `<img src="${photoUrl}" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="this.remove()">`;
    }
  });
}

// ---------------------------------------------------------------------------
// View: Korrelation (Correlation — aggregate absence vs grades)
// ---------------------------------------------------------------------------

// Meritvärde scale: F=0, E=10, D=12.5, C=15, B=17.5, A=20
// (MERIT_POINTS is defined near the top of this file)
const CORR_BUCKET_LABELS = ['0–5%', '5–10%', '10–15%', '15–20%', '20–30%', '30%+'];

/** Assign an absence-percent value to a bucket index (0–5). */
function absenceBucket(pct: number): number {
  if (pct < 5)  return 0;
  if (pct < 10) return 1;
  if (pct < 15) return 2;
  if (pct < 20) return 3;
  if (pct < 30) return 4;
  return 5;
}

/** Map a grade value string to its meritvärde (0–20 scale, or null if unknown). */
function gradeNumeric(value: string): number | null {
  const n = MERIT_POINTS[value.toUpperCase()];
  return n !== undefined ? n : null;
}

/** Format a meritvärde average as label string, e.g. 15.0 → "C (15.0)" */
function fmtGradeAvg(avg: number): string {
  const rounded = Math.round(avg * 10) / 10;
  let letter = '?';
  if (avg >= 18.75) letter = 'A';
  else if (avg >= 16.25) letter = 'B';
  else if (avg >= 13.75) letter = 'C';
  else if (avg >= 11.25) letter = 'D';
  else if (avg >= 5) letter = 'E';
  else letter = 'F';
  return `${letter} (${rounded})`;
}

/** Color for a meritvärde 0–20: green=high, red=low */
function gradeColor(avg: number): string {
  if (avg >= 16) return '#27ae60';
  if (avg >= 13) return '#4F6A8C';
  if (avg >= 10) return '#d4a017';
  return '#c0392b';
}

function renderCorrelation(): void {
  destroyCharts();

  if (data.grades.length === 0 || data.studentSummaries.length === 0) {
    main().innerHTML = `
      <h2 class="page-title">Korrelation</h2>
      <div class="empty">
        <div class="empty-icon">&#128200;</div>
        <div class="empty-text">Inga betyg att korrelera — hämta data först</div>
        <div class="empty-hint">Samla in betygsinformation och frånvaro från Progress.</div>
        <button class="btn btn-accent" id="btn-fetch-inline" style="margin-top:16px;padding:10px 24px;font-size:14px;">
          Hämta data från Progress
        </button>
      </div>
    `;
    return;
  }

  // ── Build per-student dataset: absencePct + list of numeric grades ─────────

  interface StudentGradeAbsence {
    readonly studentName: string;
    readonly absencePct: number;
    readonly numericGrades: number[];
  }

  const summaryMap = new Map(data.studentSummaries.map((s) => [s.studentName, s]));

  // Group grades by student
  const gradesByStudent = new Map<string, number[]>();
  for (const g of data.grades) {
    const n = gradeNumeric(g.value);
    if (n === null) continue;
    const list = gradesByStudent.get(g.studentName) ?? [];
    list.push(n);
    gradesByStudent.set(g.studentName, list);
  }

  const dataset: StudentGradeAbsence[] = [];
  for (const [studentName, numericGrades] of gradesByStudent) {
    const summary = summaryMap.get(studentName);
    if (!summary) continue;
    dataset.push({ studentName, absencePct: summary.totalAbsencePercent, numericGrades });
  }

  // ── Absence bucket → avg grade ─────────────────────────────────────────────

  const bucketGrades: number[][] = Array.from({ length: 6 }, () => []);
  for (const s of dataset) {
    const bi = absenceBucket(s.absencePct);
    for (const g of s.numericGrades) bucketGrades[bi].push(g);
  }

  const bucketAvgs = bucketGrades.map((grades) =>
    grades.length > 0 ? grades.reduce((a, b) => a + b, 0) / grades.length : NaN
  );

  // ── Key insights ──────────────────────────────────────────────────────────

  // Students with <10% absence
  const lowAbsGrades = dataset
    .filter((s) => s.absencePct < 10)
    .flatMap((s) => s.numericGrades);
  const lowAbsAvg = lowAbsGrades.length > 0
    ? lowAbsGrades.reduce((a, b) => a + b, 0) / lowAbsGrades.length
    : null;

  // Students with >20% absence
  const highAbsGrades = dataset
    .filter((s) => s.absencePct > 20)
    .flatMap((s) => s.numericGrades);
  const highAbsAvg = highAbsGrades.length > 0
    ? highAbsGrades.reduce((a, b) => a + b, 0) / highAbsGrades.length
    : null;

  // Grade drop per 10% absence (linear estimate from bucket avgs)
  const filledBuckets = bucketAvgs
    .map((avg, i) => ({ avg, midpoint: [2.5, 7.5, 12.5, 17.5, 25, 35][i] }))
    .filter((b) => !isNaN(b.avg));
  let gradeDropPer10 = NaN;
  if (filledBuckets.length >= 2) {
    const first = filledBuckets[0];
    const last = filledBuckets[filledBuckets.length - 1];
    const absRange = last.midpoint - first.midpoint;
    const gradeRange = last.avg - first.avg;
    if (absRange > 0) gradeDropPer10 = Math.round(Math.abs(gradeRange / absRange) * 10 * 100) / 100;
  }

  const insightLowText = lowAbsAvg !== null
    ? `Elever med &lt;10% frånvaro har meritvärde <strong>${fmtGradeAvg(lowAbsAvg)}</strong>`
    : null;
  const insightHighText = highAbsAvg !== null
    ? `Elever med &gt;20% frånvaro har meritvärde <strong>${fmtGradeAvg(highAbsAvg)}</strong>`
    : null;
  const insightDropText = !isNaN(gradeDropPer10)
    ? `Betygssnitt sjunker med <strong>${gradeDropPer10} steg</strong> per 10% frånvaro`
    : null;

  const insightCards = [insightLowText, insightHighText, insightDropText]
    .filter(Boolean)
    .map((text) => `
      <div class="report-insight" style="
        display:flex;gap:8px;padding:10px 12px;margin-bottom:8px;
        background:var(--bg-elevated);border-radius:6px;border-left:3px solid #4F6A8C;
        font-size:13px;color:var(--text-secondary);line-height:1.5
      ">${text}</div>
    `).join('');

  // ── Grade distribution per bucket (stacked) ───────────────────────────────

  // bucketGradeDist[bucketIndex][gradeIndex] = count
  const bucketGradeDist: number[][] = Array.from({ length: 6 }, () => Array(6).fill(0));
  for (const s of dataset) {
    const bi = absenceBucket(s.absencePct);
    for (const g of s.numericGrades) {
      bucketGradeDist[bi][g]++;
    }
  }

  // ── Course-level data: build per-course aggregates ───────────────────────

  interface CourseCorr {
    readonly courseName: string;
    readonly studentCount: number;
    readonly avgAbsencePct: number;
    readonly avgGrade: number;
    readonly riskScore: number;
  }

  const courseMap = new Map<string, { absences: number[]; grades: number[] }>();
  for (const g of data.grades) {
    const n = gradeNumeric(g.value);
    if (n === null) continue;
    const summary = summaryMap.get(g.studentName);
    if (!summary) continue;
    const entry = courseMap.get(g.courseName) ?? { absences: [], grades: [] };
    entry.absences.push(summary.totalAbsencePercent);
    entry.grades.push(n);
    courseMap.set(g.courseName, entry);
  }

  const allCourseCorrs: CourseCorr[] = [...courseMap.entries()]
    .map(([courseName, { absences, grades }]) => {
      const avgAbsencePct = Math.round(absences.reduce((a, b) => a + b, 0) / absences.length * 10) / 10;
      const avgGrade = Math.round(grades.reduce((a, b) => a + b, 0) / grades.length * 100) / 100;
      const riskScore = Math.round((avgAbsencePct / 100) * (1 - avgGrade / 20) * 1000) / 1000;
      return { courseName, studentCount: grades.length, avgAbsencePct, avgGrade, riskScore };
    });

  // ── Filter: only courses with >= 5 students ───────────────────────────────

  const MIN_STUDENTS = 5;
  const hiddenCount = allCourseCorrs.filter((c) => c.studentCount < MIN_STUDENTS).length;
  const courseCorrs = allCourseCorrs
    .filter((c) => c.studentCount >= MIN_STUDENTS)
    .sort((a, b) => b.riskScore - a.riskScore);

  // ── Regression: grade = a * absencePct + b ───────────────────────────────

  // Build flat point list from dataset for regression
  const regPoints: Array<{ x: number; y: number }> = [];
  for (const s of dataset) {
    const avg = s.numericGrades.reduce((a, b) => a + b, 0) / s.numericGrades.length;
    regPoints.push({ x: s.absencePct, y: avg });
  }

  let regressionSlope = NaN;
  let correlationR = NaN;
  if (regPoints.length >= 3) {
    const n = regPoints.length;
    const sumX = regPoints.reduce((a, p) => a + p.x, 0);
    const sumY = regPoints.reduce((a, p) => a + p.y, 0);
    const sumXY = regPoints.reduce((a, p) => a + p.x * p.y, 0);
    const sumX2 = regPoints.reduce((a, p) => a + p.x * p.x, 0);
    const sumY2 = regPoints.reduce((a, p) => a + p.y * p.y, 0);
    const denom = n * sumX2 - sumX * sumX;
    if (denom !== 0) {
      regressionSlope = (n * sumXY - sumX * sumY) / denom;
      const rNum = n * sumXY - sumX * sumY;
      const rDen = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
      correlationR = rDen > 0 ? Math.round(rNum / rDen * 100) / 100 : NaN;
    }
  }

  // ── Per-course auto-generated insights (Swedish) ──────────────────────────

  function courseInsight(absencePct: number, avgGrade: number): string {
    const absPct = Math.round(absencePct);
    const gradeStr = fmtGradeAvg(avgGrade);
    if (absencePct > 30 && avgGrade <= 12.5) {
      return `Hög frånvaro (${absPct}%) kombinerat med låga betyg (snitt ${gradeStr}) — rekommenderar samtal med kursansvarig.`;
    }
    if (absencePct > 30 && avgGrade >= 16.25) {
      return `Trots hög frånvaro (${absPct}%) presterar eleverna väl (snitt ${gradeStr}) — möjlig betygsinflation eller ovanligt motiverade elever.`;
    }
    if (absencePct < 15 && avgGrade <= 10) {
      return `Låg frånvaro men svaga resultat (snitt ${gradeStr}) — kursen kan vara för svår eller undervisningen behöver ses över.`;
    }
    if (absencePct < 15 && avgGrade >= 17.5) {
      return `Välfungerande kurs — god närvaro och starka resultat.`;
    }
    if (absencePct > 25) {
      return `Frånvaron (${absPct}%) är över gränsvärdet — undersök orsaker.`;
    }
    return `Kursen ligger inom normala parametrar.`;
  }

  // ── Risk tag HTML ─────────────────────────────────────────────────────────

  function riskTag(riskScore: number): string {
    if (riskScore > 0.15) {
      return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:rgba(192,57,43,0.15);color:#c0392b">Kräver åtgärd</span>`;
    }
    if (riskScore >= 0.08) {
      return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:rgba(212,160,23,0.15);color:#d4a017">Bevaka</span>`;
    }
    return '';
  }

  // ── Horizontal bar helper ─────────────────────────────────────────────────

  function miniBar(value: number, max: number, color: string): string {
    const pct = Math.min(100, Math.round(value / max * 100));
    return `<div style="height:8px;border-radius:4px;background:var(--bg-elevated);overflow:hidden;flex:1">
      <div style="height:100%;width:${pct}%;background:${color};border-radius:4px;transition:width 0.3s"></div>
    </div>`;
  }

  // ── Course cards HTML ─────────────────────────────────────────────────────

  const courseCards = courseCorrs.map((c) => {
    const absColor = pctColor(c.avgAbsencePct);
    const grColor = gradeColor(c.avgGrade);
    const insight = courseInsight(c.avgAbsencePct, c.avgGrade);
    const tag = riskTag(c.riskScore);
    const borderColor = c.riskScore > 0.15 ? '#c0392b' : c.riskScore >= 0.08 ? '#d4a017' : 'var(--border-subtle)';
    return `
      <div class="card" style="margin-bottom:10px;border-left:3px solid ${borderColor};padding:12px 14px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
          <div>
            <span style="font-size:13px;font-weight:600;color:var(--text-primary)">${esc(c.courseName)}</span>
            <span style="font-size:11px;color:var(--text-dim);margin-left:6px">${c.studentCount} elever</span>
          </div>
          ${tag}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
          <div>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:3px">Frånvaro</div>
            <div style="display:flex;align-items:center;gap:6px">
              ${miniBar(c.avgAbsencePct, 60, absColor)}
              <span style="font-size:12px;font-weight:600;color:${absColor};white-space:nowrap;font-variant-numeric:tabular-nums">${c.avgAbsencePct}%</span>
            </div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:3px">Meritvärde</div>
            <div style="display:flex;align-items:center;gap:6px">
              ${miniBar(c.avgGrade, 20, grColor)}
              <span style="font-size:12px;font-weight:600;color:${grColor};white-space:nowrap;font-variant-numeric:tabular-nums">${fmtGradeAvg(c.avgGrade)}</span>
            </div>
          </div>
        </div>
        <div style="font-size:12px;color:var(--text-dim);line-height:1.5;padding-top:6px;border-top:1px solid var(--border-subtle)">${insight}</div>
      </div>
    `;
  }).join('');

  // ── Program grouping ──────────────────────────────────────────────────────

  const PROGRAM_GROUPS: Array<{ label: string; keywords: string[] }> = [
    { label: 'IT-kurser', keywords: ['Dator', 'Programmering', 'Nätverks', 'Webbutveckling', 'Gränssnitt'] },
    { label: 'NA-kurser', keywords: ['Biologi', 'Kemi', 'Fysik', 'Matematik'] },
    { label: 'Gemensamma kurser', keywords: ['Svenska', 'Engelska', 'Historia', 'Samhällskunskap', 'Idrott', 'Religionskunskap', 'Naturkunskap'] },
  ];

  function programGroup(courseName: string): string {
    for (const g of PROGRAM_GROUPS) {
      if (g.keywords.some((kw) => courseName.includes(kw))) return g.label;
    }
    return 'Övrigt';
  }

  interface ProgramGroupResult {
    label: string;
    courses: CourseCorr[];
    avgAbsence: number;
    avgGrade: number;
  }

  const groupMap = new Map<string, CourseCorr[]>();
  for (const g of [...PROGRAM_GROUPS.map((g) => g.label), 'Övrigt']) groupMap.set(g, []);
  for (const c of courseCorrs) {
    const gLabel = programGroup(c.courseName);
    groupMap.get(gLabel)!.push(c);
  }

  const programGroups: ProgramGroupResult[] = [...groupMap.entries()]
    .filter(([, courses]) => courses.length > 0)
    .map(([label, courses]) => ({
      label,
      courses,
      avgAbsence: Math.round(courses.reduce((a, c) => a + c.avgAbsencePct, 0) / courses.length * 10) / 10,
      avgGrade: Math.round(courses.reduce((a, c) => a + c.avgGrade, 0) / courses.length * 100) / 100,
    }));

  function programInsight(group: ProgramGroupResult): string {
    if (group.courses.length === 0) return '';
    const highRisk = group.courses.filter((c) => c.riskScore > 0.15).length;
    if (highRisk > 0) {
      return `${highRisk} av ${group.courses.length} kurser kräver åtgärd — snittfrånvaro ${group.avgAbsence}%, meritvärde ${fmtGradeAvg(group.avgGrade)}.`;
    }
    if (group.avgAbsence < 10 && group.avgGrade >= 16.25) {
      return `Starkt program — låg frånvaro och goda betyg genomgående.`;
    }
    if (group.avgAbsence > 25) {
      return `Förhöjd frånvaro i programmet (snitt ${group.avgAbsence}%) — kräver uppmärksamhet.`;
    }
    return `${group.courses.length} kurser — snittfrånvaro ${group.avgAbsence}%, meritvärde ${fmtGradeAvg(group.avgGrade)}.`;
  }

  const programGroupCards = programGroups.map((g) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border-subtle)">
      <div>
        <span style="font-size:13px;font-weight:600;color:var(--text-primary)">${esc(g.label)}</span>
        <span style="font-size:11px;color:var(--text-dim);margin-left:6px">${g.courses.length} kurser</span>
      </div>
      <div style="text-align:right">
        <span style="font-size:12px;color:${pctColor(g.avgAbsence)};margin-right:12px;font-variant-numeric:tabular-nums">${g.avgAbsence}% frånvaro</span>
        <span style="font-size:12px;color:${gradeColor(g.avgGrade)};font-variant-numeric:tabular-nums">${fmtGradeAvg(g.avgGrade)}</span>
      </div>
    </div>
    <p style="font-size:12px;color:var(--text-dim);margin:4px 0 8px">${programInsight(g)}</p>
  `).join('');

  // ── Regression insight card ───────────────────────────────────────────────

  const regressionInsightHtml = !isNaN(regressionSlope)
    ? `<div class="report-insight" style="
        display:flex;gap:8px;padding:12px 14px;margin-bottom:12px;
        background:var(--bg-elevated);border-radius:6px;border-left:3px solid #4F6A8C;
        font-size:13px;color:var(--text-secondary);line-height:1.5
      ">
        <span>
          Analys: för varje 10 procentenheter ökad frånvaro sjunker meritvärdeet med
          <strong>~${Math.abs(Math.round(regressionSlope * 10 * 100) / 100)} steg</strong>
          ${!isNaN(correlationR) ? `&nbsp;(korrelationskoefficient r&nbsp;=&nbsp;<strong>${correlationR}</strong>)` : ''}
        </span>
      </div>`
    : '';

  // ── Render HTML ────────────────────────────────────────────────────────────

  main().innerHTML = `
    <h2 class="page-title">Korrelation</h2>
    <p class="page-subtitle">Frånvaro vs. betyg — ${dataset.length} elever med matchad data</p>

    <!-- Insight cards -->
    <div style="margin-bottom:20px">
      ${insightCards || '<p style="color:var(--text-dim);font-size:13px">Otillräcklig data för insikter.</p>'}
    </div>

    <!-- Chart a: Absence bracket → avg grade -->
    <div class="card-grid" style="margin-bottom:20px">
      <div class="card">
        <div class="card-header">
          <span class="card-title">Meritvärde per frånvaro­nivå</span>
        </div>
        <div class="chart-container"><canvas id="chart-corr-avg"></canvas></div>
      </div>

      <!-- Chart c: Stacked grade distribution per bucket -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Betygsdistribution per frånvaro­nivå</span>
        </div>
        <div class="chart-container"><canvas id="chart-corr-dist"></canvas></div>
      </div>
    </div>

    <!-- Course-level analysis section -->
    <div class="report-section" style="margin-bottom:8px">
      <h3 style="font-size:15px;font-weight:600;color:var(--text-primary);margin:0 0 12px">Analys per kurs</h3>

      ${regressionInsightHtml}

      ${hiddenCount > 0
        ? `<p style="font-size:12px;color:var(--text-dim);margin-bottom:12px">${hiddenCount} kurser med färre än ${MIN_STUDENTS} elever dolda</p>`
        : ''}

      ${courseCorrs.length > 0
        ? courseCards
        : '<p style="color:var(--text-dim);font-size:13px">Ingen kursdata tillgänglig.</p>'}
    </div>

    <!-- Program grouping section -->
    ${programGroups.length > 0 ? `
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <span class="card-title">Analys per program</span>
      </div>
      <div style="padding:0 4px">
        ${programGroupCards}
      </div>
    </div>
    ` : ''}
  `;

  // ── Chart a: horizontal bar — avg grade per absence bracket ───────────────

  const avgCtx = (document.getElementById('chart-corr-avg') as HTMLCanvasElement).getContext('2d')!;
  const avgColors = bucketAvgs.map((avg) => isNaN(avg) ? '#C8C1B680' : gradeColor(avg) + 'CC');
  const avgBorders = bucketAvgs.map((avg) => isNaN(avg) ? '#C8C1B6' : gradeColor(avg));

  charts.push(new Chart(avgCtx, {
    type: 'bar',
    data: {
      labels: CORR_BUCKET_LABELS,
      datasets: [{
        label: 'Meritvärde',
        data: bucketAvgs.map((v) => isNaN(v) ? null : Math.round(v * 100) / 100),
        backgroundColor: avgColors,
        borderColor: avgBorders,
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...darkTooltip(),
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.x as number;
              return ` ${fmtGradeAvg(v)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ...darkScales({ xTitle: 'Meritvärde (F=0, A=20)' }).x,
          min: 0,
          max: 20,
        },
        y: { ...darkScales().y, grid: { color: '#E6E0D8' } },
      },
    },
  }));

  // ── Chart c: stacked bar — grade distribution per absence bracket ──────────

  const gradeStackColors = ['#c0392b', '#d4a017', '#ADBCD7', '#4F6A8C', '#384A66', '#27ae60'];
  const gradeStackBorders = ['#c0392b', '#d4a017', '#ADBCD7', '#4F6A8C', '#384A66', '#27ae60'];

  const stackDatasets = CORR_GRADE_LABELS.map((label, gi) => ({
    label,
    data: bucketGradeDist.map((bucket) => bucket[gi]),
    backgroundColor: gradeStackColors[gi] + 'CC',
    borderColor: gradeStackBorders[gi],
    borderWidth: 1,
  }));

  const distCtx = (document.getElementById('chart-corr-dist') as HTMLCanvasElement).getContext('2d')!;
  charts.push(new Chart(distCtx, {
    type: 'bar',
    data: {
      labels: CORR_BUCKET_LABELS,
      datasets: stackDatasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#4F6A8C', padding: 12, font: { size: 11 } },
        },
        tooltip: { ...darkTooltip() },
      },
      scales: {
        x: { ...darkScales().x, stacked: true },
        y: { ...darkScales({ yTitle: 'Antal betyg' }).y, stacked: true },
      },
    },
  }));
}

// ---------------------------------------------------------------------------
// View: SYV-lista (Counseling view)
// ---------------------------------------------------------------------------

function renderSyv(): void {
  destroyCharts();

  const counseling = data.counselingData ?? [];
  if (counseling.length === 0) {
    main().innerHTML = renderEmpty(
      'SYV — Studievägledning',
      '&#128218;',
      'Ingen studievägledningsdata insamlad',
      'Samla in data från Progress SYV-export.'
    );
    attachInlineFetch();
    return;
  }

  type SyvStatus = 'ok' | 'bevaka' | 'risk' | 'blockerad';

  function syvStatus(c: StudentCounselingData): SyvStatus {
    if (c.failedPoints > c.maxAllowedF) return 'blockerad';
    const usedRatio = c.maxAllowedF > 0 ? c.failedPoints / c.maxAllowedF : 0;
    if (usedRatio > 0.7) return 'risk';
    if (usedRatio > 0.5) return 'bevaka';
    return 'ok';
  }

  function statusLabel(s: SyvStatus): string {
    switch (s) {
      case 'ok': return 'Examen möjlig';
      case 'bevaka': return 'Bevaka';
      case 'risk': return 'Risk';
      case 'blockerad': return 'Blockerad';
    }
  }

  function statusColor(s: SyvStatus): string {
    switch (s) {
      case 'ok': return '#27ae60';
      case 'bevaka': return '#d4a017';
      case 'risk': return '#c0392b';
      case 'blockerad': return '#7f1d1d';
    }
  }

  function statusBg(s: SyvStatus): string {
    switch (s) {
      case 'ok': return '#27ae6018';
      case 'bevaka': return '#d4a01718';
      case 'risk': return '#c0392b18';
      case 'blockerad': return '#7f1d1d20';
    }
  }

  const statusPriority: Record<SyvStatus, number> = { blockerad: 0, risk: 1, bevaka: 2, ok: 3 };

  const sorted = [...counseling].sort((a, b) => {
    const sa = syvStatus(a);
    const sb = syvStatus(b);
    if (statusPriority[sa] !== statusPriority[sb]) return statusPriority[sa] - statusPriority[sb];
    return b.failedPoints - a.failedPoints;
  });

  const atRisk = counseling.filter(c => c.graduationAtRisk).length;
  const extended = counseling.filter(c => c.totalPoints > 2500).length;
  const hasF = counseling.filter(c => c.failedPoints > 0).length;

  const rows = sorted.map(c => {
    const s = syvStatus(c);
    const sc = statusColor(s);
    const sb = statusBg(s);
    return `
      <tr style="background:${sb};border-left:3px solid ${sc}">
        <td><strong>${esc(c.studentName)}</strong></td>
        <td style="color:var(--text-muted);font-size:12px">${esc(c.className)}</td>
        <td style="font-size:12px;color:var(--text-secondary)">${esc(c.yearGroup)}</td>
        <td style="font-variant-numeric:tabular-nums;font-weight:600;color:#c0392b">${c.failedPoints}</td>
        <td style="font-variant-numeric:tabular-nums;color:var(--text-secondary)">${c.maxAllowedF}</td>
        <td style="font-variant-numeric:tabular-nums;font-weight:600;color:${c.fPointsRemaining < 50 ? '#c0392b' : c.fPointsRemaining < 150 ? '#d4a017' : '#27ae60'}">${c.fPointsRemaining}</td>
        <td style="font-variant-numeric:tabular-nums;font-size:12px;color:var(--text-secondary)">${c.lateAssignments}</td>
        <td style="font-variant-numeric:tabular-nums;font-size:12px;color:var(--text-secondary)">${c.warnings}</td>
        <td><span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:${sb};color:${sc};border:1px solid ${sc}40">${statusLabel(s)}</span></td>
      </tr>
    `;
  }).join('');

  main().innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <h2 class="page-title" style="margin-bottom:0">SYV — Studievägledning</h2>
        <p class="page-subtitle">Examensstatus och studiesituation</p>
      </div>
      <button id="btn-export-syv" class="btn" style="padding:6px 14px;font-size:12px;white-space:nowrap">Exportera CSV</button>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">Totalt elever</div>
        <div class="stat-value">${counseling.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Examenrisk</div>
        <div class="stat-value" style="color:#c0392b">${atRisk}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Utökat program</div>
        <div class="stat-value" style="color:#d4a017">${extended}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Har F-betyg</div>
        <div class="stat-value" style="color:#c0392b">${hasF}</div>
      </div>
    </div>

    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead>
          <tr>
            <th>Elev</th>
            <th>Klass</th>
            <th>Program</th>
            <th style="color:#c0392b">Poäng F</th>
            <th>Max F</th>
            <th>Marginal</th>
            <th>Sena uppg.</th>
            <th>Uppmärks.</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  document.getElementById('btn-export-syv')?.addEventListener('click', () => {
    exportCsv(sorted.map(c => ({
      Elev: c.studentName,
      Klass: c.className,
      Program: c.yearGroup,
      'Poäng F': c.failedPoints,
      'Max F': c.maxAllowedF,
      Marginal: c.fPointsRemaining,
      'Sena uppgifter': c.lateAssignments,
      Uppmärksammande: c.warnings,
      Status: statusLabel(syvStatus(c)),
    })), 'syv-lista.csv');
  });
}

// ---------------------------------------------------------------------------
// Veckobrev generator
// ---------------------------------------------------------------------------

function generateWeeklyLetter(studentNames: string[]): string {
  const today = new Date();
  const startOfYear = new Date(today.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((today.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);

  const summaryMap = new Map(data.studentSummaries.map(s => [s.studentName, s]));
  const recMap = recordsByStudent();
  const counselingMap = new Map((data.counselingData ?? []).map(c => [c.studentName, c]));

  // HT vs VT comparison
  const htPeriod = getPeriod('ht');
  const vtPeriod = getPeriod('vt');
  const htMap = new Map(htPeriod?.summaries.map(s => [s.studentName, s]) ?? []);
  const vtMap = new Map(vtPeriod?.summaries.map(s => [s.studentName, s]) ?? []);

  interface StudentInfo {
    readonly name: string;
    readonly absencePct: number;
    readonly patterns: string[];
    readonly trend: string;
    readonly action: string;
    readonly counseling: StudentCounselingData | undefined;
  }

  const infos: StudentInfo[] = studentNames.map(name => {
    const summary = summaryMap.get(name);
    const records = recMap.get(name) ?? [];
    const patterns = detectPatterns(name, records);
    const counseling = counselingMap.get(name);
    const absencePct = summary?.totalAbsencePercent ?? 0;

    const htS = htMap.get(name);
    const vtS = vtMap.get(name);
    let trend = 'stabil trend';
    if (htS && vtS) {
      const diff = vtS.totalAbsencePercent - htS.totalAbsencePercent;
      if (diff > 5) trend = `ökande trend (HT ${htS.totalAbsencePercent}% → VT ${vtS.totalAbsencePercent}%)`;
      else if (diff < -5) trend = `sjunkande trend (HT ${htS.totalAbsencePercent}% → VT ${vtS.totalAbsencePercent}%)`;
    }

    let action = 'Bevaka närvaro';
    if (absencePct >= 30) action = 'Akut insats krävs — daglig kontakt med elev och hem';
    else if (absencePct >= 15) action = 'Boka samtal med elev och vårdnadshavare';
    else if (absencePct >= 10) action = 'Uppmärksamma och följ upp nästa vecka';

    return { name, absencePct, patterns, trend, action, counseling };
  });

  const needsAttention = infos.filter(i => i.absencePct >= 15);
  const watchList = infos.filter(i => i.absencePct >= 10 && i.absencePct < 15);
  const good = infos.filter(i => i.absencePct < 10);

  const lines: string[] = [];
  lines.push(`Veckosammanfattning — Vecka ${weekNum}`);
  lines.push('');
  lines.push(`Totalt ${studentNames.length} elever i din mentorsgrupp.`);

  if (needsAttention.length > 0) {
    lines.push('');
    lines.push('KRÄVER UPPMÄRKSAMHET:');
    for (const i of needsAttention) {
      const patternStr = i.patterns.length > 0 ? i.patterns[0] : i.trend;
      lines.push(`• ${i.name} — ${i.absencePct}% total frånvaro, ${patternStr}. Åtgärd: ${i.action}`);
    }
  }

  if (watchList.length > 0) {
    lines.push('');
    lines.push('BEVAKA:');
    for (const i of watchList) {
      lines.push(`• ${i.name} — ${i.absencePct}% frånvaro, ${i.trend}`);
    }
  }

  lines.push('');
  lines.push('GOD NÄRVARO:');
  lines.push(`${good.length} elever har god närvaro (<10%).`);

  // Study situation
  const studyIssues = infos.filter(i => i.counseling && (i.counseling.failedPoints > 0 || i.counseling.lateAssignments >= 5));
  if (studyIssues.length > 0) {
    lines.push('');
    lines.push('STUDIESITUATION:');
    for (const i of studyIssues) {
      const c = i.counseling!;
      if (c.failedPoints > 0 && c.graduationAtRisk) {
        lines.push(`• ${i.name} har ${c.failedPoints}p F — risk för studiebevis`);
      } else if (c.failedPoints > 0) {
        lines.push(`• ${i.name} har ${c.failedPoints}p F`);
      }
      if (c.lateAssignments >= 5) {
        lines.push(`• ${i.name} har ${c.lateAssignments} sena uppgifter`);
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// View: Mentorsvy (Mentor)
// ---------------------------------------------------------------------------

function renderMentor(): void {
  destroyCharts();

  const STORAGE_KEY = 'edukatus-analytics-mentor-group';
  const savedNames: string[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');

  const allSummaries = data.studentSummaries;
  if (allSummaries.length === 0) {
    main().innerHTML = renderEmpty(
      'Mentorsvy',
      '&#128101;',
      'Ingen elevdata insamlad',
      'Samla in data från Progress.'
    );
    attachInlineFetch();
    return;
  }

  // Show picker if no group saved or explicitly requested
  const showPicker = savedNames.length === 0;

  if (showPicker) {
    renderMentorPicker();
    return;
  }

  // Build mentor group data
  const summaryMap = new Map(allSummaries.map(s => [s.studentName, s]));
  const mentorSummaries = savedNames
    .map(n => summaryMap.get(n))
    .filter((s): s is StudentAbsenceSummary => s !== undefined);

  if (mentorSummaries.length === 0) {
    renderMentorPicker();
    return;
  }

  const recMap = filteredRecordsByStudent();
  const counselingMap = new Map((data.counselingData ?? []).map(c => [c.studentName, c]));
  const htPeriod = getPeriod('ht');
  const vtPeriod = getPeriod('vt');
  const htMap = new Map(htPeriod?.summaries.map(s => [s.studentName, s]) ?? []);
  const vtMap = new Map(vtPeriod?.summaries.map(s => [s.studentName, s]) ?? []);

  const groupSize = mentorSummaries.length;
  const avgAbsence = Math.round(mentorSummaries.reduce((a, s) => a + s.totalAbsencePercent, 0) / groupSize * 10) / 10;
  const needsAction = mentorSummaries.filter(s => s.totalAbsencePercent >= 15).length;

  // Average grade
  const gradesByStudent = new Map<string, number[]>();
  for (const g of data.grades) {
    const n = MERIT_POINTS[g.value.toUpperCase()];
    if (n === undefined) continue;
    if (!savedNames.includes(g.studentName)) continue;
    const list = gradesByStudent.get(g.studentName) ?? [];
    list.push(n);
    gradesByStudent.set(g.studentName, list);
  }
  const allGrades: number[] = [];
  for (const grades of gradesByStudent.values()) allGrades.push(...grades);
  const avgGrade = allGrades.length > 0
    ? Math.round(allGrades.reduce((a, b) => a + b, 0) / allGrades.length * 10) / 10
    : NaN;

  const sorted = [...mentorSummaries].sort((a, b) => b.totalAbsencePercent - a.totalAbsencePercent);

  const studentRows = sorted.map(s => {
    const isExpanded = expandedStudentName === s.studentName;
    const htS = htMap.get(s.studentName);
    const vtS = vtMap.get(s.studentName);
    let trendArrow = '—';
    if (htS && vtS) {
      const diff = vtS.totalAbsencePercent - htS.totalAbsencePercent;
      trendArrow = diff > 5 ? `<span style="color:#c0392b">&#8679; +${diff}%</span>`
        : diff < -5 ? `<span style="color:#27ae60">&#8681; ${diff}%</span>`
        : `<span style="color:var(--text-dim)">&#8596;</span>`;
    }

    const counseling = counselingMap.get(s.studentName);
    const fStatus = counseling
      ? `<span style="color:${counseling.graduationAtRisk ? '#c0392b' : counseling.failedPoints > 0 ? '#d4a017' : '#27ae60'}">${counseling.failedPoints}p F</span>`
      : '—';

    const records = recMap.get(s.studentName) ?? [];
    const patterns = detectPatterns(s.studentName, records);
    const patternText = patterns.length > 0 ? patterns[0] : '';

    return `
      <tr data-mentor-student="${esc(s.studentName)}" style="${rowBgStyle(s.totalAbsencePercent)};cursor:pointer" class="${isExpanded ? 'expanded' : ''}">
        <td><strong>${esc(s.studentName)}</strong></td>
        <td style="color:var(--text-muted);font-size:12px">${esc(s.className)}</td>
        <td style="font-variant-numeric:tabular-nums;font-weight:600;color:${pctColor(s.totalAbsencePercent)}">${s.totalAbsencePercent}%</td>
        <td style="font-size:13px">${trendArrow}</td>
        <td style="font-size:12px">${fStatus}</td>
        <td style="font-size:12px;color:var(--text-dim);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(patternText)}</td>
      </tr>
      ${isExpanded ? `<tr><td colspan="6" style="padding:0">${renderExpansion(s, records)}</td></tr>` : ''}
    `;
  }).join('');

  main().innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <h2 class="page-title" style="margin-bottom:0">Mentorsvy</h2>
        <p class="page-subtitle">Din mentorsgrupp — ${groupSize} elever</p>
      </div>
      <div style="display:flex;gap:8px">
        <button id="btn-mentor-letter" class="btn" style="padding:6px 14px;font-size:12px">Generera veckobrev</button>
        <button id="btn-mentor-change" class="btn" style="padding:6px 14px;font-size:12px">Ändra grupp</button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">Gruppstorlek</div>
        <div class="stat-value">${groupSize}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Snittfrånvaro</div>
        <div class="stat-value" style="color:${pctColor(avgAbsence)}">${avgAbsence}%</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Kräver åtgärd</div>
        <div class="stat-value" style="color:#c0392b">${needsAction}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Meritvärde</div>
        <div class="stat-value">${!isNaN(avgGrade) ? fmtGradeAvg(avgGrade) : '—'}</div>
      </div>
    </div>

    <div id="mentor-letter-area" style="display:none;margin-bottom:16px">
      <div class="card">
        <div class="card-header">
          <span class="card-title">Veckobrev</span>
          <button id="btn-copy-letter" class="btn" style="padding:4px 12px;font-size:12px">Kopiera</button>
        </div>
        <textarea id="mentor-letter-text" readonly style="
          width:100%;box-sizing:border-box;min-height:250px;
          background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;
          padding:12px;font-size:13px;color:var(--text-secondary);font-family:var(--font);
          resize:vertical;line-height:1.6
        "></textarea>
      </div>
    </div>

    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead>
          <tr>
            <th>Namn</th>
            <th>Klass</th>
            <th>Frånvaro</th>
            <th>Trend</th>
            <th>F-poäng</th>
            <th>Mönster</th>
          </tr>
        </thead>
        <tbody>${studentRows}</tbody>
      </table>
    </div>
  `;

  // Event handlers
  document.getElementById('btn-mentor-change')?.addEventListener('click', () => {
    renderMentorPicker();
  });

  document.getElementById('btn-mentor-letter')?.addEventListener('click', () => {
    const area = document.getElementById('mentor-letter-area')!;
    const textarea = document.getElementById('mentor-letter-text') as HTMLTextAreaElement;
    const letter = generateWeeklyLetter(savedNames);
    textarea.value = letter;
    area.style.display = '';
  });

  document.getElementById('btn-copy-letter')?.addEventListener('click', () => {
    const textarea = document.getElementById('mentor-letter-text') as HTMLTextAreaElement;
    navigator.clipboard.writeText(textarea.value).then(() => {
      const btn = document.getElementById('btn-copy-letter')!;
      btn.textContent = 'Kopierat!';
      setTimeout(() => { btn.textContent = 'Kopiera'; }, 2000);
    }).catch(() => {
      (document.getElementById('mentor-letter-text') as HTMLTextAreaElement).select();
    });
  });

  document.querySelectorAll<HTMLElement>('tr[data-mentor-student]').forEach(row => {
    row.addEventListener('click', () => {
      const name = row.dataset.mentorStudent!;
      expandedStudentName = expandedStudentName === name ? null : name;
      renderMentor();
    });
  });
}

function renderMentorPicker(): void {
  const STORAGE_KEY = 'edukatus-analytics-mentor-group';
  const savedNames: string[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');

  // Group students by class
  const byClass = new Map<string, StudentAbsenceSummary[]>();
  for (const s of data.studentSummaries) {
    const cls = s.className || 'Okänd klass';
    const list = byClass.get(cls) ?? [];
    list.push(s);
    byClass.set(cls, list);
  }
  const classNames = [...byClass.keys()].sort();

  const classGroups = classNames.map(cls => {
    const students = byClass.get(cls)!;
    const studentCheckboxes = students
      .sort((a, b) => a.studentName.localeCompare(b.studentName))
      .map(s => `
        <label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:13px;color:var(--text-secondary);cursor:pointer">
          <input type="checkbox" class="mentor-checkbox" value="${esc(s.studentName)}" ${savedNames.includes(s.studentName) ? 'checked' : ''} />
          ${esc(s.studentName)}
          <span style="font-size:11px;color:${pctColor(s.totalAbsencePercent)};margin-left:auto;font-variant-numeric:tabular-nums">${s.totalAbsencePercent}%</span>
        </label>
      `).join('');

    return `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-weight:600;font-size:14px;color:var(--text-primary)">${esc(cls)}</span>
          <button class="btn mentor-select-class" data-class="${esc(cls)}" style="padding:3px 10px;font-size:11px">Välj alla i klass</button>
        </div>
        ${studentCheckboxes}
      </div>
    `;
  }).join('');

  main().innerHTML = `
    <h2 class="page-title">Mentorsvy — Välj mentorsgrupp</h2>
    <p class="page-subtitle">Välj de elever som tillhör din mentorsgrupp</p>
    <div style="margin-bottom:12px;display:flex;gap:8px">
      <button id="btn-mentor-save" class="btn btn-accent" style="padding:8px 20px;font-size:13px">Spara mentorsgrupp</button>
      <span id="mentor-count" style="font-size:13px;color:var(--text-dim);align-self:center">${savedNames.length} valda</span>
    </div>
    ${classGroups}
  `;

  // Update count on checkbox change
  const updateCount = () => {
    const checked = document.querySelectorAll<HTMLInputElement>('.mentor-checkbox:checked').length;
    const countEl = document.getElementById('mentor-count');
    if (countEl) countEl.textContent = `${checked} valda`;
  };

  document.querySelectorAll<HTMLInputElement>('.mentor-checkbox').forEach(cb => {
    cb.addEventListener('change', updateCount);
  });

  // Select all in class
  document.querySelectorAll<HTMLElement>('.mentor-select-class').forEach(btn => {
    btn.addEventListener('click', () => {
      const cls = btn.dataset.class!;
      const students = byClass.get(cls) ?? [];
      const allNames = students.map(s => s.studentName);
      document.querySelectorAll<HTMLInputElement>('.mentor-checkbox').forEach(cb => {
        if (allNames.includes(cb.value)) cb.checked = true;
      });
      updateCount();
    });
  });

  // Save
  document.getElementById('btn-mentor-save')?.addEventListener('click', () => {
    const selected: string[] = [];
    document.querySelectorAll<HTMLInputElement>('.mentor-checkbox:checked').forEach(cb => {
      selected.push(cb.value);
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selected));
    renderMentor();
  });
}

// ---------------------------------------------------------------------------
// View: Lektionsvy (Course)
// ---------------------------------------------------------------------------

function renderCourse(): void {
  destroyCharts();

  // Collect unique course names from absenceRecords and courses
  const courseNamesFromRecords = new Set(data.absenceRecords.map(r => r.courseName));
  const courseNamesFromCourses = new Set(data.courses.map(c => c.name));
  const allCourseNames = [...new Set([...courseNamesFromRecords, ...courseNamesFromCourses])].sort();

  if (allCourseNames.length === 0) {
    main().innerHTML = renderEmpty(
      'Lektionsvy',
      '&#128218;',
      'Inga kurser hittade',
      'Samla in frånvarodata med kursdetaljer från Progress.'
    );
    attachInlineFetch();
    return;
  }

  // Use first course as default selection, or restore from a data attribute
  const courseSelectId = 'course-selector';

  const options = allCourseNames.map(c =>
    `<option value="${esc(c)}">${esc(c)}</option>`
  ).join('');

  // Build initial HTML with selector
  main().innerHTML = `
    <h2 class="page-title">Lektionsvy</h2>
    <p class="page-subtitle">Frånvaro per kurs — välj kurs nedan</p>
    <div style="margin-bottom:16px">
      <select id="${courseSelectId}" style="
        background:var(--bg-card);border:1px solid var(--border);border-radius:8px;
        padding:8px 12px;color:var(--text-primary);font-size:13px;min-width:300px;
        font-family:var(--font)
      ">${options}</select>
    </div>
    <div id="course-detail"></div>
  `;

  function renderCourseDetail(courseName: string): void {
    const container = document.getElementById('course-detail');
    if (!container) return;

    const courseRecords = data.absenceRecords.filter(r => r.courseName === courseName);

    // Match course hours by kurskod (more reliable than name matching)
    // Course names in absence data: "Svenska 3", course hours names: "25/26 Svenska 3 NA23, TE23"
    // Try kurskod match first, then substring match
    const courseHoursEntries = (data.courseHours ?? []).filter(c => {
      if (c.courseCode && courseName.includes(c.courseCode)) return true;
      // Fuzzy: course hours name contains the absence course name
      if (c.courseName.includes(courseName)) return true;
      return false;
    });
    // Aggregate if multiple sections match (e.g. "Svenska 3" for IT and NA)
    const totalScheduledLessons = courseHoursEntries.reduce((a, c) => a + c.totalLessons, 0);
    const totalUnreported = courseHoursEntries.reduce((a, c) => a + c.unreportedLessons, 0);
    const totalScheduledHours = courseHoursEntries.reduce((a, c) => a + c.scheduledHours, 0);
    const totalGuaranteedHours = courseHoursEntries.reduce((a, c) => a + c.guaranteedHours, 0);
    const reportingRate = totalScheduledLessons > 0
      ? Math.round((totalScheduledLessons - totalUnreported) / totalScheduledLessons * 100) : 0;
    const hasCourseHours = courseHoursEntries.length > 0 && totalScheduledLessons > 0;

    // Students in this course (from absence records)
    const studentMap = new Map<string, { totalAbsence: number; count: number }>();
    for (const r of courseRecords) {
      const entry = studentMap.get(r.studentName) ?? { totalAbsence: 0, count: 0 };
      studentMap.set(r.studentName, {
        totalAbsence: entry.totalAbsence + r.totalAbsenceMinutes,
        count: entry.count + 1,
      });
    }

    const summaryMap = new Map(data.studentSummaries.map(s => [s.studentName, s]));

    // KEY INSIGHT: compare each student's absence in THIS course vs their OTHER courses
    // Per-student: minutes absent in this course vs minutes absent in all other courses
    const perStudentAllRecords = new Map<string, { thisCourse: number; otherCourses: number; otherCourseCount: number }>();
    for (const name of studentMap.keys()) {
      const thisCourseMins = studentMap.get(name)!.totalAbsence;
      const allRecords = data.absenceRecords.filter(r => r.studentName === name);
      const otherRecords = allRecords.filter(r => r.courseName !== courseName);
      const otherMins = otherRecords.reduce((a, r) => a + r.totalAbsenceMinutes, 0);
      const otherCourseNames = new Set(otherRecords.map(r => r.courseName));
      perStudentAllRecords.set(name, {
        thisCourse: thisCourseMins,
        otherCourses: otherMins,
        otherCourseCount: otherCourseNames.size,
      });
    }

    const courseTotal = courseRecords.reduce((a, r) => a + r.totalAbsenceMinutes, 0);
    const courseStudentCount = studentMap.size;

    // Comparison: avg absence rate in THIS course vs these students' avg in OTHER courses
    const studentCourseRates: { name: string; thisRate: number; otherRate: number }[] = [];
    for (const [name, stats] of perStudentAllRecords) {
      const totalAll = stats.thisCourse + stats.otherCourses;
      if (totalAll === 0) continue;
      const thisRate = stats.thisCourse / (stats.thisCourse + stats.otherCourses) * 100;
      // What share of courses does this one represent?
      const totalCourses = stats.otherCourseCount + 1;
      const expectedShare = 100 / totalCourses;
      studentCourseRates.push({ name, thisRate, otherRate: expectedShare });
    }

    const avgThisShare = studentCourseRates.length > 0
      ? Math.round(studentCourseRates.reduce((a, s) => a + s.thisRate, 0) / studentCourseRates.length * 10) / 10 : 0;
    const avgExpectedShare = studentCourseRates.length > 0
      ? Math.round(studentCourseRates.reduce((a, s) => a + s.otherRate, 0) / studentCourseRates.length * 10) / 10 : 0;

    let comparisonInsight = '';
    if (studentCourseRates.length >= 3) {
      if (avgThisShare > avgExpectedShare * 1.5) {
        comparisonInsight = `<div class="report-insight" style="border-left-color:#c0392b;margin-top:12px">
          <strong>Kursspecifikt problem:</strong> Eleverna är oproportionerligt frånvarande i just denna kurs (${avgThisShare}% av deras totala frånvaro, förväntat ~${avgExpectedShare}%). Undersök kursspecifika orsaker: schemaläggning, undervisning, ämnesångest.
        </div>`;
      } else if (avgThisShare < avgExpectedShare * 0.7) {
        comparisonInsight = `<div class="report-insight" style="border-left-color:#27ae60;margin-top:12px">
          <strong>Relativt god närvaro:</strong> Eleverna är mindre frånvarande i denna kurs (${avgThisShare}%) än förväntat (${avgExpectedShare}%). Kursen fungerar väl trots generell frånvaroproblematik.
        </div>`;
      } else {
        comparisonInsight = `<div style="margin-top:12px;font-size:12px;color:var(--text-dim)">
          Frånvaron i denna kurs (${avgThisShare}% av elevernas totala) ligger nära förväntat (${avgExpectedShare}%) — inget kursspecifikt mönster.
        </div>`;
      }
    }

    // Student rows sorted by course absence desc
    const studentEntries = [...studentMap.entries()]
      .sort((a, b) => b[1].totalAbsence - a[1].totalAbsence);

    const studentRows = studentEntries.map(([name, stats]) => {
      const comparison = perStudentAllRecords.get(name);
      const totalAll = comparison ? comparison.thisCourse + comparison.otherCourses : stats.totalAbsence;
      const shareOfTotal = totalAll > 0 ? Math.round(stats.totalAbsence / totalAll * 100) : 0;
      const totalCourses = comparison ? comparison.otherCourseCount + 1 : 1;
      const expectedShare = Math.round(100 / totalCourses);
      const isHigh = shareOfTotal > expectedShare * 1.5;
      const cls = summaryMap.get(name)?.className ?? '';
      return `
        <tr${isHigh ? ' style="background:rgba(192,57,43,0.05)"' : ''}>
          <td><strong>${esc(name)}</strong></td>
          <td style="font-size:12px;color:var(--text-muted)">${esc(cls)}</td>
          <td style="font-variant-numeric:tabular-nums;font-size:12px">${fmtMinutes(stats.totalAbsence)}</td>
          <td style="font-variant-numeric:tabular-nums;font-size:12px;color:${isHigh ? '#c0392b' : 'var(--text-dim)'}">
            ${shareOfTotal}%${isHigh ? ' <span title="Högre än förväntat">!</span>' : ''}
            <span style="font-size:10px;color:var(--text-dim)">(~${expectedShare}% förv.)</span>
          </td>
          <td style="font-variant-numeric:tabular-nums;font-size:12px;color:var(--text-dim)">${stats.count} lekt.</td>
        </tr>
      `;
    }).join('');

    // Day/time pattern for this course
    const dayMins = Array<number>(7).fill(0);
    for (const r of courseRecords) {
      if (r.dayOfWeek >= 0 && r.dayOfWeek <= 6) dayMins[r.dayOfWeek] += r.totalAbsenceMinutes;
    }
    const activeDays = dayMins.slice(0, 5).filter(d => d > 0).length;
    const maxDay = Math.max(...dayMins, 1);
    const dayBars = DAY_SHORT.slice(0, 5).map((label, i) => {
      const h = Math.round(dayMins[i] / 60 * 10) / 10;
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:2px 0">
          <span style="font-size:11px;color:var(--text-muted);min-width:28px">${label}</span>
          <div class="att-bar-track" style="flex:1">
            <div class="att-bar-fill" style="width:${Math.min(100, (dayMins[i] / maxDay) * 100)}%;background:#c0392b"></div>
          </div>
          <span style="font-size:11px;font-variant-numeric:tabular-nums;color:var(--text-dim);min-width:30px;text-align:right">${dayMins[i] > 0 ? h + ' h' : '—'}</span>
        </div>
      `;
    }).join('');

    const dayNote = activeDays <= 2
      ? `<div style="font-size:11px;color:var(--text-dim);margin-top:6px;font-style:italic">Kursen verkar schemaläggas ${activeDays} dag${activeDays > 1 ? 'ar' : ''}/vecka — veckodagsmönstret speglar schemat, inte ett avvikande beteende.</div>`
      : '';

    container.innerHTML = `
      <div class="card-grid">
        <div class="card">
          <div class="card-header"><span class="card-title">Kursinfo</span></div>
          <div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:8px">${esc(courseName)}</div>
          ${hasCourseHours ? `
            <div class="detail-item" style="padding:4px 0;border-bottom:1px solid var(--border-subtle)">
              <span class="detail-item-label">Schemalagda lektioner</span>
              <span style="font-variant-numeric:tabular-nums">${totalScheduledLessons}</span>
            </div>
            <div class="detail-item" style="padding:4px 0;border-bottom:1px solid var(--border-subtle)">
              <span class="detail-item-label">Rapporteringsgrad</span>
              <span style="font-variant-numeric:tabular-nums;color:${reportingRate >= 80 ? '#27ae60' : '#c0392b'}">${reportingRate}%</span>
            </div>
            <div class="detail-item" style="padding:4px 0;border-bottom:1px solid var(--border-subtle)">
              <span class="detail-item-label">Schemalagda / Garanterade timmar</span>
              <span style="font-variant-numeric:tabular-nums">${totalScheduledHours} / ${totalGuaranteedHours} h</span>
            </div>
            ${courseHoursEntries.length > 1 ? `<div style="font-size:10px;color:var(--text-dim);margin-top:4px">${courseHoursEntries.length} sektioner sammanslagna</div>` : ''}
          ` : '<div style="font-size:12px;color:var(--text-dim)">Inga kursdetaljer hittade (kurskod matchar ej)</div>'}
          <div class="detail-item" style="padding:4px 0;border-bottom:1px solid var(--border-subtle)">
            <span class="detail-item-label">Elever med frånvaro</span>
            <span style="font-variant-numeric:tabular-nums">${courseStudentCount}</span>
          </div>
          <div class="detail-item" style="padding:4px 0">
            <span class="detail-item-label">Total frånvaro i kursen</span>
            <span style="font-variant-numeric:tabular-nums">${fmtMinutes(courseTotal)}</span>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Veckodagsmönster</span></div>
          ${courseRecords.length > 0 ? dayBars + dayNote : '<span style="font-size:12px;color:var(--text-dim)">Ingen detaljdata</span>'}
          ${comparisonInsight}
        </div>
      </div>

      ${studentEntries.length > 0 ? `
      <div class="card" style="padding:0;overflow:hidden;margin-top:16px">
        <table>
          <thead>
            <tr>
              <th>Elev</th>
              <th>Klass</th>
              <th>Frånvaro i kursen</th>
              <th>Andel av total (förväntat)</th>
              <th>Tillfällen</th>
            </tr>
          </thead>
          <tbody>${studentRows}</tbody>
        </table>
      </div>
      ` : '<div class="card" style="margin-top:16px"><span style="font-size:12px;color:var(--text-dim)">Inga elever med frånvaro i denna kurs</span></div>'}
    `;
  }

  // Initial render
  renderCourseDetail(allCourseNames[0]);

  document.getElementById(courseSelectId)?.addEventListener('change', (e) => {
    const selected = (e.target as HTMLSelectElement).value;
    renderCourseDetail(selected);
  });
}

// ---------------------------------------------------------------------------
// View: Klassvy — Jämför klasser
// ---------------------------------------------------------------------------

function renderClassCompare(): void {
  destroyCharts();

  const summaries = data.studentSummaries;
  if (summaries.length === 0) {
    main().innerHTML = renderEmpty(
      'Klassvy — Jämför klasser',
      '&#127979;',
      'Ingen elevdata insamlad',
      'Samla in data från Progress.'
    );
    attachInlineFetch();
    return;
  }

  // Group by class
  const byClass = new Map<string, StudentAbsenceSummary[]>();
  for (const s of summaries) {
    const cls = s.className || 'Okänd klass';
    const list = byClass.get(cls) ?? [];
    list.push(s);
    byClass.set(cls, list);
  }

  // Grade data
  const gradesByStudent = new Map<string, number[]>();
  for (const g of data.grades) {
    const n = MERIT_POINTS[g.value.toUpperCase()];
    if (n === undefined) continue;
    const list = gradesByStudent.get(g.studentName) ?? [];
    list.push(n);
    gradesByStudent.set(g.studentName, list);
  }

  interface ClassInfo {
    readonly name: string;
    readonly count: number;
    readonly avgAbsence: number;
    readonly minAbsence: number;
    readonly maxAbsence: number;
    readonly flaggedCount: number;
    readonly avgGrade: number;
    readonly greenPct: number;
    readonly yellowPct: number;
    readonly redPct: number;
  }

  const classInfos: ClassInfo[] = [...byClass.entries()].map(([cls, students]) => {
    const absences = students.map(s => s.totalAbsencePercent);
    const avg = Math.round(absences.reduce((a, b) => a + b, 0) / absences.length * 10) / 10;
    const flagged = students.filter(s => s.isFlagged).length;

    // Calculate class average meritvärde
    const studentMerits: number[] = [];
    for (const s of students) {
      const m = calculateMerit(s.studentName);
      if (m) studentMerits.push(m.merit);
    }
    const avgGrade = studentMerits.length > 0
      ? Math.round(studentMerits.reduce((a, b) => a + b, 0) / studentMerits.length * 100) / 100
      : NaN;

    // Distribution: green (<10%), yellow (10-15%), red (>=15%)
    const green = students.filter(s => s.totalAbsencePercent < 10).length;
    const yellow = students.filter(s => s.totalAbsencePercent >= 10 && s.totalAbsencePercent < 15).length;
    const red = students.filter(s => s.totalAbsencePercent >= 15).length;
    const total = students.length;

    return {
      name: cls,
      count: students.length,
      avgAbsence: avg,
      minAbsence: Math.min(...absences),
      maxAbsence: Math.max(...absences),
      flaggedCount: flagged,
      avgGrade,
      greenPct: Math.round(green / total * 100),
      yellowPct: Math.round(yellow / total * 100),
      redPct: Math.round(red / total * 100),
    };
  }).sort((a, b) => b.avgAbsence - a.avgAbsence);

  const cards = classInfos.map(c => `
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div>
          <strong style="font-size:14px">${esc(c.name)}</strong>
          <span style="font-size:12px;color:var(--text-dim);margin-left:8px">${c.count} elever</span>
        </div>
        <span style="font-variant-numeric:tabular-nums;font-size:16px;font-weight:700;color:${pctColor(c.avgAbsence)}">${c.avgAbsence}%</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:8px;font-size:12px">
        <div>
          <div style="color:var(--text-dim)">Min</div>
          <div style="font-variant-numeric:tabular-nums;color:${pctColor(c.minAbsence)}">${c.minAbsence}%</div>
        </div>
        <div>
          <div style="color:var(--text-dim)">Max</div>
          <div style="font-variant-numeric:tabular-nums;color:${pctColor(c.maxAbsence)}">${c.maxAbsence}%</div>
        </div>
        <div>
          <div style="color:var(--text-dim)">Flaggade</div>
          <div style="font-variant-numeric:tabular-nums;color:#c0392b">${c.flaggedCount}</div>
        </div>
        <div>
          <div style="color:var(--text-dim)">Meritvärde</div>
          <div style="font-variant-numeric:tabular-nums;color:var(--blue-600)">${!isNaN(c.avgGrade) ? c.avgGrade.toFixed(1) : '—'}</div>
        </div>
      </div>
      <div style="display:flex;height:10px;border-radius:5px;overflow:hidden">
        <div style="width:${c.greenPct}%;background:#27ae60" title="<10% frånvaro"></div>
        <div style="width:${c.yellowPct}%;background:#d4a017" title="10-15% frånvaro"></div>
        <div style="width:${c.redPct}%;background:#c0392b" title="≥15% frånvaro"></div>
      </div>
      <div style="display:flex;gap:12px;margin-top:4px;font-size:11px;color:var(--text-dim)">
        <span><span style="display:inline-block;width:8px;height:8px;background:#27ae60;border-radius:2px;margin-right:3px"></span>${c.greenPct}% god</span>
        <span><span style="display:inline-block;width:8px;height:8px;background:#d4a017;border-radius:2px;margin-right:3px"></span>${c.yellowPct}% bevaka</span>
        <span><span style="display:inline-block;width:8px;height:8px;background:#c0392b;border-radius:2px;margin-right:3px"></span>${c.redPct}% flaggad</span>
      </div>
    </div>
  `).join('');

  main().innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <h2 class="page-title" style="margin-bottom:0">Klassvy — Jämför klasser</h2>
        <p class="page-subtitle">${classInfos.length} klasser sorterade efter snittfrånvaro</p>
      </div>
      <button id="btn-export-classcompare" class="btn" style="padding:6px 14px;font-size:12px;white-space:nowrap">Exportera CSV</button>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="card-header"><span class="card-title">Jämförelse per klass</span></div>
      <div class="chart-container"><canvas id="chart-classcompare"></canvas></div>
    </div>

    ${cards}
  `;

  document.getElementById('btn-export-classcompare')?.addEventListener('click', () => {
    exportCsv(classInfos.map(c => ({
      Klass: c.name,
      Elever: c.count,
      'Snittfrånvaro %': c.avgAbsence,
      'Min %': c.minAbsence,
      'Max %': c.maxAbsence,
      Flaggade: c.flaggedCount,
      Meritvärde: !isNaN(c.avgGrade) ? fmtGradeAvg(c.avgGrade) : '',
    })), 'klassjamforelse.csv');
  });

  // Chart
  if (classInfos.length > 0) {
    const ctx = (document.getElementById('chart-classcompare') as HTMLCanvasElement).getContext('2d')!;
    charts.push(new Chart(ctx, {
      type: 'bar',
      data: {
        labels: classInfos.map(c => c.name),
        datasets: [{
          label: 'Snittfrånvaro %',
          data: classInfos.map(c => c.avgAbsence),
          backgroundColor: classInfos.map(c => pctColor(c.avgAbsence) + '80'),
          borderColor: classInfos.map(c => pctColor(c.avgAbsence)),
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { ...darkTooltip(), callbacks: { label: ctx => `${ctx.parsed.y}% frånvaro` } },
        },
        scales: darkScales({ yTitle: 'Frånvaro %' }),
      },
    }));
  }
}

// ---------------------------------------------------------------------------
// View: Rektorsrapport (Principal)
// ---------------------------------------------------------------------------

function renderPrincipal(): void {
  destroyCharts();

  const summaries = data.studentSummaries;
  if (summaries.length === 0) {
    main().innerHTML = renderEmpty(
      'Rektorsrapport',
      '&#127963;',
      'Ingen data tillgänglig',
      'Samla in data från Progress.'
    );
    attachInlineFetch();
    return;
  }

  const today = new Date().toLocaleDateString('sv-SE');
  const schoolName = data.schoolInfo?.slug ?? 'Skolan';

  const totalStudents = summaries.length;
  const avgAbsence = Math.round(summaries.reduce((a, s) => a + s.totalAbsencePercent, 0) / totalStudents * 10) / 10;
  const flaggedCount = summaries.filter(s => s.isFlagged).length;

  // Graduation risk
  const counseling = data.counselingData ?? [];
  const graduationRisk = counseling.filter(c => c.graduationAtRisk).length;

  // HT vs VT trends
  const htPeriod = getPeriod('ht');
  const vtPeriod = getPeriod('vt');
  let trendSection = '';
  if (htPeriod && vtPeriod) {
    const htAvg = htPeriod.summaries.length > 0
      ? Math.round(htPeriod.summaries.reduce((a, s) => a + s.totalAbsencePercent, 0) / htPeriod.summaries.length * 10) / 10
      : 0;
    const vtAvg = vtPeriod.summaries.length > 0
      ? Math.round(vtPeriod.summaries.reduce((a, s) => a + s.totalAbsencePercent, 0) / vtPeriod.summaries.length * 10) / 10
      : 0;

    const vtMap = new Map(vtPeriod.summaries.map(s => [s.studentName, s]));
    let improving = 0;
    let worsening = 0;
    for (const htS of htPeriod.summaries) {
      const vtS = vtMap.get(htS.studentName);
      if (!vtS) continue;
      const diff = vtS.totalAbsencePercent - htS.totalAbsencePercent;
      if (diff > 5) worsening++;
      else if (diff < -5) improving++;
    }

    trendSection = `
      <div class="card" style="margin-bottom:20px">
        <div class="card-header"><span class="card-title">Sektion 2: Trender</span></div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;font-size:13px">
          <div>
            <div style="color:var(--text-dim);font-size:11px">HT snittfrånvaro</div>
            <div style="font-weight:700;color:${pctColor(htAvg)}">${htAvg}%</div>
          </div>
          <div>
            <div style="color:var(--text-dim);font-size:11px">VT snittfrånvaro</div>
            <div style="font-weight:700;color:${pctColor(vtAvg)}">${vtAvg}%</div>
          </div>
          <div>
            <div style="color:var(--text-dim);font-size:11px">Förbättrade</div>
            <div style="font-weight:700;color:#27ae60">${improving}</div>
          </div>
          <div>
            <div style="color:var(--text-dim);font-size:11px">Försämrade</div>
            <div style="font-weight:700;color:#c0392b">${worsening}</div>
          </div>
        </div>
      </div>
    `;
  }

  // Per-class table
  const byClass = new Map<string, StudentAbsenceSummary[]>();
  for (const s of summaries) {
    const cls = s.className || 'Okänd klass';
    const list = byClass.get(cls) ?? [];
    list.push(s);
    byClass.set(cls, list);
  }

  const gradesByStudent = new Map<string, number[]>();
  for (const g of data.grades) {
    const n = MERIT_POINTS[g.value.toUpperCase()];
    if (n === undefined) continue;
    const list = gradesByStudent.get(g.studentName) ?? [];
    list.push(n);
    gradesByStudent.set(g.studentName, list);
  }

  const courseHours = data.courseHours ?? [];
  const totalLessons = courseHours.reduce((a, c) => a + c.totalLessons, 0);
  const reportedLessons = courseHours.reduce((a, c) => a + (c.totalLessons - c.unreportedLessons), 0);
  const schoolReportingRate = totalLessons > 0
    ? Math.round(reportedLessons / totalLessons * 1000) / 10
    : 0;

  const classRows = [...byClass.entries()]
    .sort(([, a], [, b]) => {
      const avgA = a.reduce((acc, s) => acc + s.totalAbsencePercent, 0) / a.length;
      const avgB = b.reduce((acc, s) => acc + s.totalAbsencePercent, 0) / b.length;
      return avgB - avgA;
    })
    .map(([cls, students]) => {
      const avg = Math.round(students.reduce((a, s) => a + s.totalAbsencePercent, 0) / students.length * 10) / 10;
      const flagged = students.filter(s => s.isFlagged).length;

      const studentGrades: number[] = [];
      for (const s of students) {
        const grades = gradesByStudent.get(s.studentName);
        if (grades) studentGrades.push(...grades);
      }
      const avgGrade = studentGrades.length > 0
        ? Math.round(studentGrades.reduce((a, b) => a + b, 0) / studentGrades.length * 100) / 100
        : NaN;

      // Data quality: sum reporting rate for courses used by students in this class
      const classCourseCH = courseHours;
      const classReportingRate = classCourseCH.length > 0
        ? Math.round(classCourseCH.reduce((a, c) => a + c.reportingRate, 0) / classCourseCH.length)
        : 0;

      return `
        <tr>
          <td><strong>${esc(cls)}</strong></td>
          <td style="font-variant-numeric:tabular-nums;text-align:center">${students.length}</td>
          <td style="font-variant-numeric:tabular-nums;font-weight:600;color:${pctColor(avg)};text-align:center">${avg}%</td>
          <td style="font-variant-numeric:tabular-nums;text-align:center;color:${!isNaN(avgGrade) ? gradeColor(avgGrade) : 'var(--text-dim)'}">${!isNaN(avgGrade) ? fmtGradeAvg(avgGrade) : '—'}</td>
          <td style="font-variant-numeric:tabular-nums;text-align:center;color:${flagged > 0 ? '#c0392b' : 'var(--text-dim)'}">${flagged}</td>
          <td style="font-variant-numeric:tabular-nums;text-align:center;color:${classReportingRate >= 80 ? '#27ae60' : '#c0392b'}">${classReportingRate}%</td>
        </tr>
      `;
    }).join('');

  // Tier 3+ students (require investigation)
  const tier3 = summaries.filter(s => s.totalAbsencePercent >= 15);
  const tier3List = tier3
    .sort((a, b) => b.totalAbsencePercent - a.totalAbsencePercent)
    .slice(0, 10)
    .map(s => `<li style="font-size:12px;color:var(--text-secondary)">${esc(s.studentName)} (${esc(s.className)}) — ${s.totalAbsencePercent}%</li>`)
    .join('');

  // Courses needing attention (from correlation data)
  const courseMap = new Map<string, { absences: number[]; grades: number[] }>();
  for (const g of data.grades) {
    const n = MERIT_POINTS[g.value.toUpperCase()];
    if (n === undefined) continue;
    const summary = summaries.find(s => s.studentName === g.studentName);
    if (!summary) continue;
    const entry = courseMap.get(g.courseName) ?? { absences: [], grades: [] };
    entry.absences.push(summary.totalAbsencePercent);
    entry.grades.push(n);
    courseMap.set(g.courseName, entry);
  }

  const coursesNeedingAttention = [...courseMap.entries()]
    .map(([name, { absences, grades }]) => ({
      name,
      avgAbsence: absences.reduce((a, b) => a + b, 0) / absences.length,
      avgGrade: grades.reduce((a, b) => a + b, 0) / grades.length,
    }))
    .filter(c => c.avgAbsence > 20 && c.avgGrade < 3)
    .sort((a, b) => b.avgAbsence - a.avgAbsence)
    .slice(0, 5);

  const courseAttentionRows = coursesNeedingAttention.map(c => `
    <li style="font-size:12px;color:var(--text-secondary)">${esc(c.name)} — ${Math.round(c.avgAbsence)}% frånvaro, snitt ${fmtGradeAvg(c.avgGrade)}</li>
  `).join('');

  // Low reporting courses
  const lowReporting = courseHours.filter(c => c.reportingRate < 80).sort((a, b) => a.reportingRate - b.reportingRate);
  const lowReportingRows = lowReporting.slice(0, 5).map(c => `
    <li style="font-size:12px;color:var(--text-secondary)">${esc(c.courseName)} — ${c.reportingRate}%</li>
  `).join('');

  main().innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
      <div>
        <h2 class="page-title" style="margin-bottom:0">Rektorsrapport — ${esc(schoolName)} — ${today}</h2>
        <p class="page-subtitle">Sammanfattning för ledning och styrelse</p>
      </div>
      <button onclick="window.print()" class="btn btn-accent" style="padding:8px 18px;font-size:13px">Skriv ut rapport</button>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="card-header"><span class="card-title">Sektion 1: Nyckeltal</span></div>
      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-label">Total elever</div>
          <div class="stat-value">${totalStudents}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Snittfrånvaro</div>
          <div class="stat-value" style="color:${pctColor(avgAbsence)}">${avgAbsence}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Flaggade (>15%)</div>
          <div class="stat-value" style="color:#c0392b">${flaggedCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Examenrisk</div>
          <div class="stat-value" style="color:#c0392b">${graduationRisk}</div>
        </div>
      </div>
    </div>

    ${trendSection}

    <div class="card" style="margin-bottom:20px">
      <div class="card-header"><span class="card-title">Sektion 3: Programöversikt</span></div>
      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Klass</th>
              <th style="text-align:center">Elever</th>
              <th style="text-align:center">Snittfrånvaro</th>
              <th style="text-align:center">Meritvärde</th>
              <th style="text-align:center">Flaggade</th>
              <th style="text-align:center">Datakvalitet</th>
            </tr>
          </thead>
          <tbody>${classRows}</tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="card-header"><span class="card-title">Sektion 4: Insatsbehov</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div>
          <h4 style="font-size:12px;text-transform:uppercase;color:var(--text-dim);margin:0 0 8px">Utredning krävs (≥15% frånvaro): ${tier3.length} elever</h4>
          ${tier3List ? `<ul style="margin:0;padding-left:18px">${tier3List}</ul>` : '<span style="font-size:12px;color:var(--text-dim)">Inga</span>'}
          ${tier3.length > 10 ? `<div style="font-size:11px;color:var(--text-dim);margin-top:4px">...och ${tier3.length - 10} till</div>` : ''}
          <div style="margin-top:12px">
            <h4 style="font-size:12px;text-transform:uppercase;color:var(--text-dim);margin:0 0 8px">Examenrisk: ${graduationRisk} elever</h4>
          </div>
        </div>
        <div>
          <h4 style="font-size:12px;text-transform:uppercase;color:var(--text-dim);margin:0 0 8px">Kurser som kräver uppmärksamhet</h4>
          ${courseAttentionRows ? `<ul style="margin:0;padding-left:18px">${courseAttentionRows}</ul>` : '<span style="font-size:12px;color:var(--text-dim)">Inga kurser med hög frånvaro + låga betyg</span>'}
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="card-header"><span class="card-title">Sektion 5: Datakvalitet</span></div>
      <div style="margin-bottom:8px">
        <span style="font-size:14px;font-weight:700;color:${schoolReportingRate >= 80 ? '#27ae60' : '#c0392b'}">${schoolReportingRate}%</span>
        <span style="font-size:12px;color:var(--text-dim);margin-left:8px">genomsnittlig rapporteringsgrad</span>
      </div>
      ${lowReporting.length > 0 ? `
        <div>
          <h4 style="font-size:12px;text-transform:uppercase;color:var(--text-dim);margin:0 0 8px">Kurser med låg rapportering (<80%)</h4>
          <ul style="margin:0;padding-left:18px">${lowReportingRows}</ul>
          ${lowReporting.length > 5 ? `<div style="font-size:11px;color:var(--text-dim);margin-top:4px">...och ${lowReporting.length - 5} till</div>` : ''}
        </div>
      ` : '<div style="font-size:12px;color:#27ae60">Alla kurser rapporterar över 80%</div>'}
    </div>

    <div style="text-align:center;padding:16px 0;font-size:11px;color:var(--text-dim);border-top:1px solid var(--border-subtle)">
      Genererad av Edukatus Analytics — ${today}. Baserat på data från Progress.
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Views that should display the global filter bar */
const FILTER_BAR_VIEWS = new Set(['overview', 'attendance', 'patterns', 'students', 'risk', 'course', 'classcompare']);

function render(): void {
  switch (currentView) {
    case 'overview':      renderOverview();      break;
    case 'attendance':    renderAttendance();    break;
    case 'patterns':      renderPatterns();      break;
    case 'students':      renderStudents();      break;
    case 'risk':          renderRisk();          break;
    case 'yearview':      renderYearView();      break;
    case 'reports':       renderReports();       break;
    case 'correlation':   renderCorrelation();   break;
    case 'mentor':        renderMentor();        break;
    case 'course':        renderCourse();        break;
    case 'syv':           renderSyv();           break;
    case 'classcompare':  renderClassCompare();  break;
    case 'principal':     renderPrincipal();     break;
    default:              renderOverview();
  }

  // Prepend filter bar for applicable views (after the view has rendered)
  if (FILTER_BAR_VIEWS.has(currentView) && data.studentSummaries.length > 0) {
    const mainEl = main();
    const filterBarEl = document.createElement('div');
    filterBarEl.innerHTML = renderFilterBar();
    const filterBarNode = filterBarEl.firstElementChild as HTMLElement;
    if (filterBarNode) {
      mainEl.insertBefore(filterBarNode, mainEl.firstChild);
    }
    attachFilterListeners();
  }

  // Attach inline fetch button if empty state was rendered
  attachInlineFetch();

  const lastEl = document.getElementById('last-updated');
  if (lastEl) {
    lastEl.textContent = data.lastUpdated
      ? `Uppdaterad ${new Date(data.lastUpdated).toLocaleString('sv-SE')}`
      : 'Ingen data ännu';
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

document.querySelectorAll<HTMLElement>('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
    item.classList.add('active');
    currentView = item.dataset.view ?? 'overview';
    expandedStudentName = null;
    selectedReportStudent = null;
    render();
  });
});

// -- Progress overlay --

function showProgress(phase: string, percent: number, detail?: string): void {
  const overlay = document.getElementById('progress-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  const phaseEl = document.getElementById('progress-phase');
  const fillEl = document.getElementById('progress-fill');
  const detailEl = document.getElementById('progress-detail');
  if (phaseEl) phaseEl.textContent = phase;
  if (fillEl) fillEl.style.width = `${Math.min(100, percent)}%`;
  if (detailEl) detailEl.textContent = detail ?? '';
}

function hideProgress(): void {
  const overlay = document.getElementById('progress-overlay');
  if (overlay) overlay.style.display = 'none';
}

// Listen for progress updates from the content script (forwarded via background)
chrome.runtime.onMessage.addListener((message: any) => {
  if (message.type === 'FETCH_STATUS') {
    const { phase, progress, detail } = message.payload;
    showProgress(phase, progress, detail);
    if (progress >= 100) {
      setTimeout(hideProgress, 1000);
    }
  }
});

async function triggerFetch(): Promise<void> {
  showProgress('Startar datahämtning...', 5, 'Ansluter till Progress');

  try {
    await new Promise<void>((resolve) => {
      chrome.runtime.sendMessage({ type: 'SCRAPE_PAGE' }, () => resolve());
      setTimeout(resolve, 120000); // 2 min timeout for grade fetching
    });

    await new Promise((r) => setTimeout(r, 1500));

    [data, guardianCache] = await Promise.all([loadData(), loadGuardians()]);
    render();
  } finally {
    hideProgress();
  }
}

$('btn-refresh').addEventListener('click', async () => {
  const btn = $('btn-refresh') as HTMLButtonElement;
  btn.disabled = true;
  try {
    await triggerFetch();
  } finally {
    btn.disabled = false;
  }
});

$('btn-clear').addEventListener('click', () => {
  if (confirm('Rensa all insamlad data?')) {
    chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, async () => {
      [data, guardianCache] = await Promise.all([loadData(), loadGuardians()]);
      expandedStudentName = null;
      render();
    });
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  [data, guardianCache] = await Promise.all([loadData(), loadGuardians()]);

  // Debug: check data integrity
  const recMap = recordsByStudent();
  const summaryNames = data.studentSummaries.map(s => s.studentName);
  const recordNames = [...recMap.keys()];
  const unmatched = summaryNames.filter(n => !recMap.has(n));
  console.log('[dashboard] summaries:', data.studentSummaries.length, 'absenceRecords:', data.absenceRecords.length);
  console.log('[dashboard] record map keys (first 5):', recordNames.slice(0, 5));
  console.log('[dashboard] summary names (first 5):', summaryNames.slice(0, 5));
  if (unmatched.length > 0) {
    console.log('[dashboard] UNMATCHED summary names (no records):', unmatched.slice(0, 10));
  }

  render();
}

init();
