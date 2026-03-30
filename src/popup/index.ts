import type { StoredData, AttendanceRecord, Grade } from '../types';

const GRADE_NUMERIC: Record<string, number> = { F: 0, E: 1, D: 2, C: 3, B: 4, A: 5 };
const GRADE_ORDER = ['F', 'E', 'D', 'C', 'B', 'A'] as const;

let currentTab = 'attendance';
let data: StoredData = {
  students: [], grades: [], attendance: [], courses: [],
  lastUpdated: null, sources: [],
};

// -- Data loading --

function loadData(): Promise<StoredData> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_ALL_DATA' }, (response) => {
      if (response?.payload) {
        resolve(response.payload);
      } else {
        resolve(data);
      }
    });
  });
}

// -- Rendering helpers --

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function rateColor(rate: number): string {
  if (rate >= 85) return 'rate-high';
  if (rate >= 70) return 'rate-med';
  return 'rate-low';
}

function gradeClass(value: string): string {
  return `grade-${value.toUpperCase()}`;
}

// -- Stats bar --

function renderStats(): void {
  const el = $('stats');
  el.innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${data.students.length}</div>
      <div class="stat-label">Elever</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${data.grades.length}</div>
      <div class="stat-label">Betyg</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${data.attendance.length}</div>
      <div class="stat-label">Närvaro</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${data.courses.length}</div>
      <div class="stat-label">Kurser</div>
    </div>
  `;
}

// -- Attendance view --

function renderAttendance(): string {
  if (data.attendance.length === 0) {
    return '<div class="empty">Ingen närvarodata. Besök frånvarosidan i Progress och klicka "Hämta data".</div>';
  }

  const sorted = [...data.attendance].sort((a, b) => a.attendanceRate - b.attendanceRate);

  const rows = sorted.map((r) => `
    <tr>
      <td>${esc(r.studentName)}</td>
      <td>${esc(r.courseName)}</td>
      <td>
        <div style="display: flex; align-items: center; gap: 6px;">
          <div class="rate-bar" style="flex: 1;">
            <div class="rate-bar-fill ${rateColor(r.attendanceRate)}" style="width: ${r.attendanceRate}%"></div>
          </div>
          <span style="min-width: 36px; text-align: right;">${r.attendanceRate}%</span>
        </div>
      </td>
    </tr>
  `).join('');

  return `
    <div class="card">
      <h3>Närvaro per elev (sorterat lägst först)</h3>
      <table>
        <thead><tr><th>Elev</th><th>Kurs</th><th>Närvaro</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// -- Grades view --

function renderGrades(): string {
  if (data.grades.length === 0) {
    return '<div class="empty">Inga betyg. Besök betygssidan i Progress och klicka "Hämta data".</div>';
  }

  // Distribution
  const counts: Record<string, number> = {};
  for (const g of GRADE_ORDER) counts[g] = 0;
  for (const grade of data.grades) {
    const v = grade.value.toUpperCase();
    if (v in counts) counts[v]++;
  }

  const maxCount = Math.max(...Object.values(counts), 1);
  const bars = GRADE_ORDER.map((g) => {
    const pct = Math.round((counts[g] / maxCount) * 100);
    return `
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
        <span class="grade-badge ${gradeClass(g)}">${g}</span>
        <div class="rate-bar" style="flex: 1;">
          <div class="rate-bar-fill ${gradeClass(g)}" style="width: ${pct}%; background: var(--c);" ></div>
        </div>
        <span style="min-width: 24px; text-align: right; color: #a1a1aa;">${counts[g]}</span>
      </div>
    `;
  }).join('');

  // Per-student grades table
  const rows = data.grades.map((g) => `
    <tr>
      <td>${esc(g.studentName)}</td>
      <td>${esc(g.courseName)}</td>
      <td><span class="grade-badge ${gradeClass(g.value)}">${esc(g.value)}</span></td>
      <td style="color: #71717a;">${esc(g.date)}</td>
    </tr>
  `).join('');

  return `
    <div class="card">
      <h3>Betygsfördelning</h3>
      ${bars}
    </div>
    <div class="card">
      <h3>Alla betyg</h3>
      <table>
        <thead><tr><th>Elev</th><th>Kurs</th><th>Betyg</th><th>Datum</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// -- Correlation view --

function renderCorrelation(): string {
  if (data.attendance.length === 0 || data.grades.length === 0) {
    return '<div class="empty">Behöver både närvaro- och betygsdata. Besök båda sidorna i Progress.</div>';
  }

  // Match attendance and grades by student name
  const attByName = new Map<string, AttendanceRecord>();
  for (const r of data.attendance) {
    const existing = attByName.get(r.studentName);
    if (!existing || r.totalLessons > existing.totalLessons) {
      attByName.set(r.studentName, r);
    }
  }

  const gradeByName = new Map<string, Grade>();
  for (const g of data.grades) {
    gradeByName.set(g.studentName, g);
  }

  const points: { name: string; attendance: number; grade: number; gradeLabel: string }[] = [];
  for (const [name, att] of attByName) {
    const gr = gradeByName.get(name);
    if (!gr || !(gr.value.toUpperCase() in GRADE_NUMERIC)) continue;
    points.push({
      name,
      attendance: att.attendanceRate,
      grade: GRADE_NUMERIC[gr.value.toUpperCase()],
      gradeLabel: gr.value.toUpperCase(),
    });
  }

  if (points.length < 3) {
    return '<div class="empty">Behöver minst 3 elever med matchad närvaro + betyg.</div>';
  }

  // Pearson correlation
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.attendance, 0);
  const sumY = points.reduce((s, p) => s + p.grade, 0);
  const sumXY = points.reduce((s, p) => s + p.attendance * p.grade, 0);
  const sumX2 = points.reduce((s, p) => s + p.attendance ** 2, 0);
  const sumY2 = points.reduce((s, p) => s + p.grade ** 2, 0);
  const denom = Math.sqrt((n * sumX2 - sumX ** 2) * (n * sumY2 - sumY ** 2));
  const r = denom === 0 ? 0 : Math.round(((n * sumXY - sumX * sumY) / denom) * 100) / 100;

  const rows = points
    .sort((a, b) => a.attendance - b.attendance)
    .map((p) => `
      <tr>
        <td>${esc(p.name)}</td>
        <td>${p.attendance}%</td>
        <td><span class="grade-badge ${gradeClass(p.gradeLabel)}">${p.gradeLabel}</span></td>
      </tr>
    `).join('');

  return `
    <div class="card">
      <h3>Korrelation: Närvaro vs Betyg</h3>
      <div style="font-size: 11px; color: #a1a1aa; margin-bottom: 8px;">
        Pearson r = <strong style="color: ${Math.abs(r) > 0.5 ? '#22c55e' : '#eab308'};">${r}</strong>
        (${points.length} elever matchade)
      </div>
      <table>
        <thead><tr><th>Elev</th><th>Närvaro</th><th>Betyg</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// -- Risk view --

function renderRisk(): string {
  if (data.attendance.length === 0 && data.grades.length === 0) {
    return '<div class="empty">Ingen data. Hämta närvaro och betyg från Progress först.</div>';
  }

  const attByName = new Map<string, AttendanceRecord>();
  for (const r of data.attendance) {
    const existing = attByName.get(r.studentName);
    if (!existing || r.totalLessons > existing.totalLessons) {
      attByName.set(r.studentName, r);
    }
  }

  const gradeByName = new Map<string, Grade>();
  for (const g of data.grades) {
    gradeByName.set(g.studentName, g);
  }

  const allNames = new Set([...attByName.keys(), ...gradeByName.keys()]);
  const risks: { name: string; attendance: number; grade: string; reasons: string[]; level: string }[] = [];

  for (const name of allNames) {
    const att = attByName.get(name);
    const gr = gradeByName.get(name);
    const reasons: string[] = [];

    const attRate = att?.attendanceRate ?? 100;
    const gradeVal = gr?.value.toUpperCase() ?? '';
    const gradeNum = GRADE_NUMERIC[gradeVal] ?? -1;

    if (attRate < 75) reasons.push(`Närvaro ${attRate}%`);
    if (gradeNum >= 0 && gradeNum <= 1) reasons.push(`Betyg ${gradeVal}`);

    if (reasons.length === 0) continue;

    const level = (reasons.length >= 2 || attRate < 50 || gradeNum === 0) ? 'high' : 'med';
    risks.push({ name, attendance: attRate, grade: gradeVal || '-', reasons, level });
  }

  risks.sort((a, b) => {
    if (a.level !== b.level) return a.level === 'high' ? -1 : 1;
    return a.attendance - b.attendance;
  });

  if (risks.length === 0) {
    return '<div class="empty">Inga riskindikerade elever med nuvarande data.</div>';
  }

  const rows = risks.map((r) => `
    <div class="card risk-${r.level}" style="padding: 8px 12px; margin-bottom: 6px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong>${esc(r.name)}</strong>
        <div style="display: flex; gap: 8px; font-size: 11px; color: #a1a1aa;">
          <span>Närvaro: ${r.attendance}%</span>
          ${r.grade !== '-' ? `<span>Betyg: <span class="grade-badge ${gradeClass(r.grade)}" style="width:20px;height:20px;line-height:20px;font-size:10px;">${r.grade}</span></span>` : ''}
        </div>
      </div>
      <div style="font-size: 10px; color: #71717a; margin-top: 2px;">${r.reasons.join(' | ')}</div>
    </div>
  `).join('');

  return `
    <div style="font-size: 11px; color: #71717a; margin-bottom: 8px;">
      ${risks.length} elever flaggade (närvaro &lt;75% eller betyg F/E)
    </div>
    ${rows}
  `;
}

// -- Utilities --

function esc(s: string): string {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

// -- Tab switching + render --

function renderContent(): void {
  const el = $('content');
  switch (currentTab) {
    case 'attendance': el.innerHTML = renderAttendance(); break;
    case 'grades': el.innerHTML = renderGrades(); break;
    case 'correlation': el.innerHTML = renderCorrelation(); break;
    case 'risk': el.innerHTML = renderRisk(); break;
  }
}

function render(): void {
  renderStats();
  renderContent();
}

// -- Event handlers --

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = (tab as HTMLElement).dataset.tab!;
    renderContent();
  });
});

$('btn-scrape').addEventListener('click', async () => {
  const btn = $('btn-scrape') as HTMLButtonElement;
  btn.textContent = 'Hämtar...';
  btn.disabled = true;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'SCRAPE_PAGE' }, async () => {
        // Wait a moment for storage to update
        await new Promise((r) => setTimeout(r, 500));
        data = await loadData();
        render();
        btn.textContent = 'Hämta data';
        btn.disabled = false;
      });
    } else {
      btn.textContent = 'Hämta data';
      btn.disabled = false;
    }
  });
});

$('btn-clear').addEventListener('click', async () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, async () => {
    data = await loadData();
    render();
  });
});

// -- Init --

async function init(): Promise<void> {
  data = await loadData();
  render();
}

init();
