import * as XLSX from 'xlsx';
import type { AbsenceRecord, StudentAbsenceSummary, PeriodSummary, PeriodLabel, Student, Course, Grade, Guardian, CourseHours, StudentCounselingData } from './types';

// -- School detection --

export interface SchoolPath {
  readonly org: string;   // e.g. "tis", "tyg"
  readonly school: string; // e.g. "tisudd", "tygsth"
}

export function detectSchoolPath(): SchoolPath | null {
  // Pattern: /{org}/schools/{school}/...
  const match = window.location.pathname.match(/\/([^/]+)\/schools\/([^/]+)/i);
  if (match) return { org: match[1], school: match[2] };

  // Fallback: check links on the page
  const links = document.querySelectorAll('a[href*="/schools/"]');
  for (const link of links) {
    const m = (link as HTMLAnchorElement).pathname.match(/\/([^/]+)\/schools\/([^/]+)/i);
    if (m) return { org: m[1], school: m[2] };
  }
  return null;
}

/** @deprecated Use detectSchoolPath() instead */
export function detectSchoolSlug(): string | null {
  return detectSchoolPath()?.school ?? null;
}

export function getBaseUrl(path: SchoolPath): string {
  return `https://progress.edukatus.se/${path.org}/schools/${path.school}`;
}

export function detectSchoolId(): number | null {
  // Look in forms, links, data attributes
  const patterns = [
    /SchoolId[=:](\d+)/i,
    /schoolId[=:](\d+)/i,
    /school_id[=:](\d+)/i,
  ];

  // Check page HTML for SchoolId references
  const html = document.documentElement.innerHTML;
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) return parseInt(m[1], 10);
  }

  // Check all links/forms for SchoolId param
  const allLinks = document.querySelectorAll('a[href*="SchoolId"], form[action*="SchoolId"]');
  for (const el of allLinks) {
    const href = (el as HTMLAnchorElement).href || (el as HTMLFormElement).action || '';
    const m = href.match(/SchoolId=(\d+)/i);
    if (m) return parseInt(m[1], 10);
  }

  return null;
}

export function getSchoolInfo(): SchoolInfo | null {
  const slug = detectSchoolSlug();
  if (!slug) return null;

  const schoolId = detectSchoolId();
  if (!schoolId) return null;

  return { slug, schoolId };
}

// -- Date helpers --

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function getDateRange(monthsBack: number): { start: string; end: string } {
  const now = new Date();
  const end = formatDate(now);
  const start = new Date(now);
  start.setMonth(start.getMonth() - monthsBack);
  return { start: formatDate(start), end };
}

function getDayOfWeek(dateStr: string): number {
  // Parse YYYY-MM-DD manually to avoid timezone issues
  const parts = dateStr.split('-');
  if (parts.length !== 3) return 0;
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1; // JS months are 0-indexed
  const d = parseInt(parts[2], 10);
  const date = new Date(y, m, d); // Local time, no UTC shift
  // JS: 0=Sun, we want 0=Mon
  return (date.getDay() + 6) % 7;
}

function getHourOfDay(timeStr: string): number {
  const parts = timeStr.split(':');
  return parseInt(parts[0] ?? '0', 10);
}

// Normalize datetime from various formats Excel/SheetJS might produce
function normalizeDatetime(raw: string): string {
  if (!raw) return '';

  // Already in "YYYY-MM-DD HH:mm" format
  if (raw.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/)) return raw;

  // ISO format "2026-03-27T11:50:00"
  if (raw.includes('T')) return raw.replace('T', ' ').replace(/:\d{2}$/, '');

  // US short format from SheetJS: "M/DD/YY HH:mm" or "MM/DD/YY HH:mm"
  // e.g. "3/27/26 11:50" or "12/5/25 08:00"
  const usShortMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}:\d{2})/);
  if (usShortMatch) {
    const [, mm, dd, yy, time] = usShortMatch;
    // 2-digit year: assume 20xx for values < 70, 19xx otherwise
    const yearNum = parseInt(yy, 10);
    const yyyy = yearNum < 70 ? 2000 + yearNum : 1900 + yearNum;
    return `${yyyy}-${String(parseInt(mm, 10)).padStart(2, '0')}-${String(parseInt(dd, 10)).padStart(2, '0')} ${time}`;
  }

  // US format without time: "M/DD/YY" or "MM/DD/YY"
  const usShortNoTime = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (usShortNoTime) {
    const [, mm, dd, yy] = usShortNoTime;
    const yearNum = parseInt(yy, 10);
    const yyyy = yearNum < 70 ? 2000 + yearNum : 1900 + yearNum;
    return `${yyyy}-${String(parseInt(mm, 10)).padStart(2, '0')}-${String(parseInt(dd, 10)).padStart(2, '0')}`;
  }

  // Excel serial date number (e.g., "46109.493")
  const num = parseFloat(raw);
  if (!isNaN(num) && num > 40000 && num < 60000) {
    const excelEpoch = new Date(1899, 11, 30);
    const ms = excelEpoch.getTime() + num * 86400000;
    const d = new Date(ms);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }

  // DD/MM/YYYY HH:mm (European long format)
  const euroMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})\s*(\d{2}:\d{2})?/);
  if (euroMatch) {
    const [, dd, mm, yyyy, time] = euroMatch;
    return `${yyyy}-${mm}-${dd}${time ? ' ' + time : ''}`;
  }

  return raw; // Return as-is if unrecognized
}

// -- XLSX export fetching --

export async function fetchAbsenceExport(
  school: SchoolPath,
  monthsBack = 2,
  onProgress?: (phase: string) => void,
): Promise<AbsenceRecord[]> {
  const { start, end } = getDateRange(monthsBack);
  const base = getBaseUrl(school);

  onProgress?.(`Hämtar frånvarodata ${start} till ${end}...`);

  const url = `${base}/Absence/DetailsExport?sort=Date&sortdir=DESC&StartDate=${start}&EndDate=${end}&advanced=False`;

  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching absence export`);
  }

  onProgress?.('Tolkar Excel-data...');

  // Read as base64 to avoid Firefox content script ArrayBuffer compartment issues
  const blob = await response.blob();
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const b64 = result.split(',')[1] ?? '';
      resolve(b64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const workbook = XLSX.read(base64, { type: 'base64' });

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('No sheets in workbook');

  const sheet = workbook.Sheets[sheetName];
  // raw: false ensures dates come as formatted strings, not serial numbers
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });

  onProgress?.(`Bearbetar ${rows.length} rader...`);

  // Log first row to help debug column names and date formats
  if (rows.length > 0) {
    console.log('[edukatus-analytics] First row keys:', Object.keys(rows[0]));
    console.log('[edukatus-analytics] First row sample:', JSON.stringify(rows[0]));
  }

  const records: AbsenceRecord[] = [];

  for (const row of rows) {
    const studentName = String(row['Elev'] ?? '').trim();
    if (!studentName) continue;

    const className = String(row['Klass'] ?? '').trim();
    const absenceMinutes = parseFloat(String(row['Frånvaro (minuter)'] ?? '0')) || 0;
    const reportedMinutes = parseFloat(String(row['Anmäld frånvaro (minuter)'] ?? '0')) || 0;
    const lessonStartRaw = String(row['Lektionens starttid'] ?? '').trim();
    const lessonEndRaw = String(row['Lektionens sluttid'] ?? '').trim();
    const timeOfDay = String(row['Lektionens tidpunkt'] ?? '').trim();
    const courseName = String(row['Kurstillfälle'] ?? '').trim();
    const teacher = String(row['Rapporterad av'] ?? '').trim();

    // Normalize lesson start/end — could be "2026-03-27 11:50" or Excel serial number
    const lessonStart = normalizeDatetime(lessonStartRaw);
    const lessonEnd = normalizeDatetime(lessonEndRaw);

    // Extract date (YYYY-MM-DD) from the normalized datetime
    const date = lessonStart.split(' ')[0] ?? lessonStart.split('T')[0] ?? '';
    const totalAbsenceMinutes = absenceMinutes + reportedMinutes;

    // Only include records where there's actually absence
    if (totalAbsenceMinutes === 0) continue;

    const dayOfWeek = date ? getDayOfWeek(date) : -1;

    // Skip weekends (5=Sat, 6=Sun) — these are data errors
    if (dayOfWeek >= 5) continue;

    // Skip records with invalid dates
    if (!date || !date.match(/^\d{4}-\d{2}-\d{2}$/)) continue;

    records.push({
      studentName,
      className,
      absenceMinutes,
      reportedMinutes,
      lessonStart,
      lessonEnd,
      timeOfDay,
      courseName,
      teacher,
      date,
      dayOfWeek,
      hourOfDay: timeOfDay ? getHourOfDay(timeOfDay) : 0,
      totalAbsenceMinutes,
      isExcused: reportedMinutes > 0 && absenceMinutes === 0,
    });
  }

  onProgress?.(`${records.length} frånvaroposter hämtade`);
  return records;
}

const ABSENCE_THRESHOLD = 15; // Flag students with >= 15% total absence

export async function fetchStudentSummaries(
  school: SchoolPath,
  monthsBack = 2,
  onProgress?: (phase: string) => void,
): Promise<StudentAbsenceSummary[]> {
  const { start, end } = getDateRange(monthsBack);
  const base = getBaseUrl(school);

  onProgress?.(`Hämtar elevsammanställning ${start} till ${end}...`);

  const url = `${base}/Absence/StudentsExport?StartDate=${start}&EndDate=${end}&advanced=False`;

  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching student summary export`);
  }

  const blob = await response.blob();
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  const workbook = XLSX.read(base64, { type: 'base64' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('No sheets in student summary workbook');

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });

  if (rows.length > 0) {
    console.log('[edukatus-analytics] Student summary first row:', JSON.stringify(rows[0]));
  }

  const summaries: StudentAbsenceSummary[] = [];

  for (const row of rows) {
    const studentName = String(row['Elev'] ?? '').trim();
    if (!studentName) continue;

    const className = String(row['Klass'] ?? '').trim();

    // Parse numbers — Swedish decimals use comma (0,196 = 0.196)
    const parseNum = (val: unknown): number => {
      const s = String(val ?? '0').replace(',', '.').trim();
      return parseFloat(s) || 0;
    };

    const totalScheduledMinutes = parseNum(row['Lektionstid']);
    const unexcusedMinutes = parseNum(row['Oanmäld frånvaro']);
    const unexcusedPercent = parseNum(row['Oanmäld frånvaroprocent']) * 100;
    const unexcusedCount = parseNum(row['Oanmälda tillfällen']);
    const excusedMinutes = parseNum(row['Anmäld frånvaro']);
    const excusedPercent = parseNum(row['Anmäld frånvaroprocent']) * 100;
    const excusedCount = parseNum(row['Anmälda tillfällen']);
    const totalAbsencePercent = parseNum(row['Total frånvaroprocent']) * 100;

    summaries.push({
      studentName,
      className,
      totalScheduledMinutes,
      unexcusedMinutes,
      unexcusedPercent: Math.round(unexcusedPercent * 10) / 10,
      unexcusedCount,
      excusedMinutes,
      excusedPercent: Math.round(excusedPercent * 10) / 10,
      excusedCount,
      totalAbsencePercent: Math.round(totalAbsencePercent * 10) / 10,
      isFlagged: totalAbsencePercent >= ABSENCE_THRESHOLD,
    });
  }

  summaries.sort((a, b) => b.totalAbsencePercent - a.totalAbsencePercent);
  onProgress?.(`${summaries.length} elever, ${summaries.filter(s => s.isFlagged).length} flaggade (>=${ABSENCE_THRESHOLD}%)`);
  return summaries;
}

// -- School year periods --

function getSchoolYearPeriods(): { label: PeriodLabel; displayLabel: string; start: string; end: string }[] {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  // School year starts mid-August
  // If we're before August, the school year started last year
  const schoolYearStart = month >= 7 // August = 7
    ? `${year}-08-15`
    : `${year - 1}-08-15`;

  const htEnd = month >= 7
    ? `${year}-12-31`
    : `${year - 1}-12-31`;

  const vtStart = month >= 7
    ? `${year + 1}-01-01`
    : `${year}-01-01`;

  const today = formatDate(now);

  // Recent = last 2 months
  const recentStart = new Date(now);
  recentStart.setMonth(recentStart.getMonth() - 2);

  // Previous school year dates
  // If current year started in Aug {syStartYear}, prev year started Aug {syStartYear-1}
  const syStartYear = month >= 7 ? year : year - 1;
  const prevYearStart = `${syStartYear - 1}-08-15`;
  const prevHtEnd = `${syStartYear - 1}-12-31`;
  const prevVtStart = `${syStartYear}-01-01`;
  const prevYearEnd = `${syStartYear}-06-15`;

  return [
    { label: 'year',      displayLabel: 'Helår',              start: schoolYearStart,  end: today },
    { label: 'ht',        displayLabel: 'HT (Hösttermin)',    start: schoolYearStart,  end: htEnd },
    { label: 'vt',        displayLabel: 'VT (Vårtermin)',     start: vtStart,          end: today },
    { label: 'recent',    displayLabel: 'Senaste 2 månader',  start: formatDate(recentStart), end: today },
    { label: 'prev-year', displayLabel: 'Helår (förra)',      start: prevYearStart,    end: prevYearEnd },
    { label: 'prev-ht',   displayLabel: 'HT (förra)',         start: prevYearStart,    end: prevHtEnd },
    { label: 'prev-vt',   displayLabel: 'VT (förra)',         start: prevVtStart,      end: prevYearEnd },
  ];
}

export async function fetchAllPeriods(
  school: SchoolPath,
  onProgress?: (phase: string) => void,
): Promise<PeriodSummary[]> {
  const allPeriods = getSchoolYearPeriods();

  // Split into current-year and previous-year buckets
  const prevLabels = new Set<PeriodLabel>(['prev-year', 'prev-ht', 'prev-vt']);
  const currentPeriods = allPeriods.filter((p) => !prevLabels.has(p.label));
  const prevPeriods = allPeriods.filter((p) => prevLabels.has(p.label));

  onProgress?.(`Hämtar data för ${currentPeriods.length} innevarande perioder...`);

  const results: PeriodSummary[] = [];

  // Fetch current-year periods first
  for (const period of currentPeriods) {
    onProgress?.(`Hämtar ${period.displayLabel} (${period.start} — ${period.end})...`);
    try {
      const summaries = await fetchStudentSummariesForRange(school, period.start, period.end);
      results.push({
        period: period.label,
        periodLabel: period.displayLabel,
        startDate: period.start,
        endDate: period.end,
        summaries,
      });
    } catch (err) {
      console.warn(`[edukatus-analytics] Failed to fetch ${period.label}:`, err);
    }
  }

  // Fetch previous-year periods sequentially after current year
  onProgress?.(`Hämtar data för ${prevPeriods.length} föregående perioder...`);

  for (const period of prevPeriods) {
    onProgress?.(`Hämtar ${period.displayLabel} (${period.start} — ${period.end})...`);
    try {
      const summaries = await fetchStudentSummariesForRange(school, period.start, period.end);
      results.push({
        period: period.label,
        periodLabel: period.displayLabel,
        startDate: period.start,
        endDate: period.end,
        summaries,
      });
    } catch (err) {
      console.warn(`[edukatus-analytics] Failed to fetch ${period.label}:`, err);
    }
  }

  return results;
}

// Fetch StudentsExport for a specific date range
async function fetchStudentSummariesForRange(
  school: SchoolPath,
  startDate: string,
  endDate: string,
): Promise<StudentAbsenceSummary[]> {
  const base = getBaseUrl(school);
  const url = `${base}/Absence/StudentsExport?StartDate=${startDate}&EndDate=${endDate}&advanced=False`;

  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const blob = await response.blob();
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  const workbook = XLSX.read(base64, { type: 'base64' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });

  const parseNum = (val: unknown): number => {
    const s = String(val ?? '0').replace(',', '.').trim();
    return parseFloat(s) || 0;
  };

  const summaries: StudentAbsenceSummary[] = [];
  for (const row of rows) {
    const studentName = String(row['Elev'] ?? '').trim();
    if (!studentName) continue;

    const totalAbsencePercent = parseNum(row['Total frånvaroprocent']) * 100;

    summaries.push({
      studentName,
      className: String(row['Klass'] ?? '').trim(),
      totalScheduledMinutes: parseNum(row['Lektionstid']),
      unexcusedMinutes: parseNum(row['Oanmäld frånvaro']),
      unexcusedPercent: Math.round(parseNum(row['Oanmäld frånvaroprocent']) * 1000) / 10,
      unexcusedCount: parseNum(row['Oanmälda tillfällen']),
      excusedMinutes: parseNum(row['Anmäld frånvaro']),
      excusedPercent: Math.round(parseNum(row['Anmäld frånvaroprocent']) * 1000) / 10,
      excusedCount: parseNum(row['Anmälda tillfällen']),
      totalAbsencePercent: Math.round(totalAbsencePercent * 10) / 10,
      isFlagged: totalAbsencePercent >= ABSENCE_THRESHOLD,
    });
  }

  return summaries.sort((a, b) => b.totalAbsencePercent - a.totalAbsencePercent);
}

// -- Programmatic student list fetch (gets name → ID mapping) --

export async function fetchStudentList(school: SchoolPath): Promise<Student[]> {
  const base = getBaseUrl(school);
  const students: Student[] = [];
  const seen = new Set<string>();

  try {
    const response = await fetch(`${base}/student`, { credentials: 'include' });
    if (!response.ok) return students;

    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Extract all Student/Show links with their numeric IDs
    const links = doc.querySelectorAll('a[href*="/Student/Show/"]');
    for (const link of links) {
      const href = (link as HTMLAnchorElement).getAttribute('href') ?? '';
      const match = href.match(/\/Student\/Show\/(\d+)/i);
      if (!match) continue;

      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);

      const name = (link.textContent ?? '').trim();
      if (!name) continue;

      // Try to find class from the table row
      const row = link.closest('tr');
      let className = '';
      if (row) {
        const cells = row.querySelectorAll('td');
        for (const cell of cells) {
          const text = (cell.textContent ?? '').trim();
          if (text !== name && text.match(/^[A-Z]{2,6}\d{2}$/)) {
            className = text;
            break;
          }
        }
      }

      students.push({ id, name, className });
    }

    console.log(`[edukatus-analytics] Fetched ${students.length} students with IDs from student list`);
  } catch (err) {
    console.warn('[edukatus-analytics] Failed to fetch student list:', err);
  }

  return students;
}

// -- Grade fetching from student programme pages --

export async function fetchGradesForStudents(
  school: SchoolPath,
  students: Student[],
  onProgress?: (phase: string) => void,
): Promise<Grade[]> {
  const base = getBaseUrl(school);
  const allGrades: Grade[] = [];

  // Only fetch for students with numeric IDs
  const studentsWithIds = students.filter((s) => s.id.match(/^\d+$/));
  if (studentsWithIds.length === 0) return allGrades;

  onProgress?.(`Hämtar betyg för ${studentsWithIds.length} elever...`);

  // Fetch in batches to avoid hammering the server
  for (let i = 0; i < studentsWithIds.length; i++) {
    const student = studentsWithIds[i];
    onProgress?.(`Betyg: ${student.name} (${i + 1}/${studentsWithIds.length})`);

    try {
      const url = `${base}/Student/ShowProgramme/${student.id}`;
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) continue;

      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const gradePattern = /^[A-F]$/;

      // Parse ONLY gymnasiekurser from #highTab / #courseListByStatus
      // Each row: td[0]=course link, td[2]=poäng, td[3]=grade (td.grade-success),
      //           td[4]=teacher, td[5]=dates, td.courseStatusGroup=Finished/Ongoing
      // Only parse from the status-grouped table (avoid duplicates from year/category views)
      const gymTables = doc.querySelectorAll('#courseListByStatus .courseTable');
      for (const table of gymTables) {
        const rows = table.querySelectorAll('tbody tr');
        for (const row of rows) {
          // Skip group header rows
          if (row.classList.contains('tableGroupHeader') || row.classList.contains('tableGroupNoContent')) continue;

          const gradeCell = row.querySelector('td.grade-success, td.grade-danger');
          if (!gradeCell) continue; // No grade = ongoing/planned, skip

          const gradeSpan = gradeCell.querySelector('span');
          const gradeText = (gradeSpan?.textContent ?? '').trim().toUpperCase();
          if (!gradePattern.test(gradeText)) continue;

          // Course name and code from first cell's link
          // Format: "Biologi 1 (BIOBIO01)" — name with code in parentheses
          const courseLink = row.querySelector('td:first-child a');
          const courseFullText = (courseLink?.textContent ?? '').trim();
          if (!courseFullText) continue;

          const codeMatch = courseFullText.match(/\(([A-Z0-9]+)\)\s*$/);
          const courseCode = codeMatch ? codeMatch[1] : '';
          const courseName = codeMatch ? courseFullText.replace(/\s*\([A-Z0-9]+\)\s*$/, '').trim() : courseFullText;

          // Credits (poäng) from third column (td[2])
          const cells = row.querySelectorAll('td');
          const creditsText = (cells[2]?.textContent ?? '').trim();
          const credits = parseInt(creditsText, 10) || 0;

          // Check if extended course (utökad) — badge with "Ut" text
          const badges = row.querySelectorAll('.programmeCourseMarking-extended');
          const isExtended = badges.length > 0;

          // Check if gymnasiearbete — course code starts with GYA
          const isGymnasiearbete = courseCode.startsWith('GYA');

          // Date from grade span's title: "10/6-24, Elin Jarhed (96084)"
          const titleAttr = gradeSpan?.getAttribute('title') ?? '';
          const dateMatch = titleAttr.match(/(\d{1,2})\/(\d{1,2})-(\d{2})/);
          let gradeDate = '';
          if (dateMatch) {
            const [, d, m, y] = dateMatch;
            const yearFull = parseInt(y, 10) < 70 ? 2000 + parseInt(y, 10) : 1900 + parseInt(y, 10);
            gradeDate = `${yearFull}-${String(parseInt(m, 10)).padStart(2, '0')}-${String(parseInt(d, 10)).padStart(2, '0')}`;
          }

          // Status (Finished/Ongoing)
          const statusCell = row.querySelector('td.courseStatusGroup');
          const status = (statusCell?.textContent ?? '').trim();
          if (status === 'Ongoing' || status === 'Planned') continue;

          allGrades.push({
            studentId: student.id,
            studentName: student.name,
            courseId: '',
            courseName,
            courseCode,
            value: gradeText,
            credits,
            date: gradeDate,
            isExtended,
            isGymnasiearbete,
          });
        }
      }

      // Throttle: small delay between students
      if (i < studentsWithIds.length - 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (err) {
      console.warn(`[edukatus-analytics] Failed to fetch grades for ${student.name}:`, err);
    }
  }

  console.log(`[edukatus-analytics] Fetched ${allGrades.length} grades for ${studentsWithIds.length} students`);
  return allGrades;
}

// -- Student extraction from current page --

// -- Course hours fetching --

export async function fetchCourseHours(
  school: SchoolPath,
  onProgress?: (phase: string) => void,
): Promise<CourseHours[]> {
  const base = getBaseUrl(school);
  const url = `${base}/course/ExportLessonTimes?OnlyMyCourses=False&Planned=False&Ongoing=True&Finished=False&StudentCount=0&SkipTrialCourses=True&AlsoRemoved=False&AlsoExpired=False&WithoutGuardians=False&Advanced=False&Page=1&PageSize=500&Sort=StartDate&SortDir=DESC&IsFiltered=False&CompanyId=0&SpecificUser=False&IncludeStudentsWithoutAbsence=False&ShowOnlyStudentsWithDiscrepancies=False&ShowExtraStudentInfo=False`;

  onProgress?.('Hämtar kursdata (lektionstider)...');

  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching course hours`);
  }

  const blob = await response.blob();
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  const workbook = XLSX.read(base64, { type: 'base64' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('No sheets in course hours workbook');

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });

  const parseNum = (val: unknown): number => {
    const s = String(val ?? '0').replace(',', '.').trim();
    return parseFloat(s) || 0;
  };

  const courses: CourseHours[] = [];

  for (const row of rows) {
    const courseName = String(row['Namn'] ?? '').trim();
    if (!courseName) continue;

    const courseCode = String(row['Kurskod'] ?? '').trim();
    const startDate = String(row['Startdatum'] ?? '').trim();
    const endDate = String(row['Slutdatum'] ?? '').trim();
    const totalLessons = parseNum(row['Antal lektioner']);
    const cancelledLessons = parseNum(row['Inställda lektioner']);
    const unreportedLessons = parseNum(row['Orapporterade lektioner']);
    const scheduledHours = parseNum(row['Schemalagd lektionstid']);
    const guaranteedHours = parseNum(row['Garanterad undervisningstid']);

    const reportingRate = totalLessons > 0
      ? Math.round(((totalLessons - unreportedLessons) / totalLessons) * 1000) / 10
      : 0;

    courses.push({
      courseName,
      courseCode,
      startDate,
      endDate,
      totalLessons,
      cancelledLessons,
      unreportedLessons,
      scheduledHours,
      guaranteedHours,
      reportingRate,
    });
  }

  onProgress?.(`${courses.length} kurser hämtade`);
  return courses;
}

// -- Program type detection from class name --

function detectProgramType(className: string): StudentCounselingData['programType'] {
  const upper = className.toUpperCase().trim();
  // Högskoleförberedande programs
  if (/^(NA|TE)\d/.test(upper)) return 'hogskoleforberedande';
  // Yrkesprogram
  if (/^(IT|IMYEE|EE|BA|BF|SA|RL|HV|VF|FT|IN|NB)\d/.test(upper)) return 'yrkesprogram';
  return 'unknown';
}

// -- Student counseling data fetching --

export async function fetchCounselingData(
  school: SchoolPath,
  onProgress?: (phase: string) => void,
): Promise<StudentCounselingData[]> {
  const base = getBaseUrl(school);
  const url = `${base}/StudentCounseling/ExportToExcel?sort=StudentName&advanced=False`;

  onProgress?.('Hämtar studievägledningsdata...');

  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching counseling data`);
  }

  const blob = await response.blob();
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  const workbook = XLSX.read(base64, { type: 'base64' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('No sheets in counseling data workbook');

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });

  const parseNum = (val: unknown): number => {
    const s = String(val ?? '0').replace(',', '.').trim();
    return parseFloat(s) || 0;
  };

  const students: StudentCounselingData[] = [];

  for (const row of rows) {
    const studentName = String(row['Elev'] ?? '').trim();
    if (!studentName) continue;

    const yearGroup = String(row['Årskull'] ?? '').trim();
    const className = String(row['Klass'] ?? '').trim();
    const totalPoints = parseNum(row['Poäng']);
    const remainingElective = parseNum(row['Kvarvarande valbara poäng']);
    const warnings = parseNum(row['Uppmärksammande']);
    const failedPoints = parseNum(row['Poäng F']);
    const dashPoints = parseNum(row['Poäng --']);
    const lateAssignments = parseNum(row['Sena uppgifter']);
    const failedAssignments = parseNum(row['Underkända uppgifter']);
    const unexcusedAbsence = String(row['Oanmäld frånvaro'] ?? '').trim();
    const excusedAbsence = String(row['Anmäld frånvaro'] ?? '').trim();

    const programType = detectProgramType(className);
    const maxAllowedF = programType === 'yrkesprogram' ? 500 : 250;
    const fPointsRemaining = maxAllowedF - failedPoints;
    // At risk if within 30% of limit (i.e. used more than 70% of allowed F points)
    const graduationAtRisk = failedPoints > maxAllowedF * 0.7;

    students.push({
      studentName,
      yearGroup,
      className,
      totalPoints,
      remainingElective,
      warnings,
      failedPoints,
      dashPoints,
      lateAssignments,
      failedAssignments,
      unexcusedAbsence,
      excusedAbsence,
      maxAllowedF,
      fPointsRemaining,
      graduationAtRisk,
      programType,
    });
  }

  onProgress?.(`${students.length} elevers studiesituation hämtad`);
  return students;
}

export function scrapeStudentsFromPage(): Student[] {
  const students: Student[] = [];
  const seen = new Set<string>();

  const links = document.querySelectorAll('a[href*="/Student/Show/"]');
  for (const link of links) {
    const href = (link as HTMLAnchorElement).href;
    const match = href.match(/\/Student\/Show\/(\d+)/i);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const name = (link.textContent ?? '').trim();
    if (name) students.push({ id, name, className: '' });
  }

  return students;
}

// -- Course extraction from page --

export function scrapeCoursesFromPage(): Course[] {
  const courses: Course[] = [];
  const seen = new Set<string>();

  const links = document.querySelectorAll('a[href*="/Course/Show/"]');
  for (const link of links) {
    const name = (link.textContent ?? '').trim();
    const href = (link as HTMLAnchorElement).href;
    const match = href.match(/\/Course\/Show\/(\d+)/i);
    if (name && !seen.has(name)) {
      seen.add(name);
      courses.push({ id: match?.[1] ?? '', name, className: '', teacher: '' });
    }
  }

  return courses;
}

// -- Student profile picture fetching --
// URL pattern: /public/profileimages/{rangeLow}-{rangeHigh}/{studentId}_Original-{hash}.jpg
// Range = 500-wide buckets: ID 111052 → range 111001-111500

const photoCache = new Map<string, string | null>();

export async function fetchStudentPhoto(
  school: SchoolPath,
  studentId: string,
): Promise<string | null> {
  const cacheKey = `${school.org}/${school.school}/${studentId}`;
  if (photoCache.has(cacheKey)) return photoCache.get(cacheKey)!;

  try {
    const base = getBaseUrl(school);
    const url = `${base}/Student/Show/${studentId}`;

    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
      photoCache.set(cacheKey, null);
      return null;
    }

    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Strategy 1 (best): look for the known profileimages URL pattern
    const allImgs = doc.querySelectorAll('img[src]');
    for (const img of allImgs) {
      const src = (img as HTMLImageElement).getAttribute('src') ?? '';
      if (src.includes('/profileimages/') || src.includes('/profileimage')) {
        const photoUrl = src.startsWith('/') ? `https://progress.edukatus.se${src}` : src;
        console.log(`[edukatus-analytics] Found profile image for ${studentId}: ${photoUrl}`);
        photoCache.set(cacheKey, photoUrl);
        return photoUrl;
      }
    }

    // Strategy 2: look for img src containing the student ID
    for (const img of allImgs) {
      const src = (img as HTMLImageElement).getAttribute('src') ?? '';
      if (src.includes(studentId) && !src.includes('logo') && !src.includes('icon')) {
        const photoUrl = src.startsWith('/') ? `https://progress.edukatus.se${src}` : src;
        console.log(`[edukatus-analytics] Found ID-matched image for ${studentId}: ${photoUrl}`);
        photoCache.set(cacheKey, photoUrl);
        return photoUrl;
      }
    }

    // Strategy 3: look inside profile/avatar containers
    const profileContainers = doc.querySelectorAll(
      '[class*="profile"] img, [class*="avatar"] img, [class*="photo"] img'
    );
    for (const img of profileContainers) {
      const src = (img as HTMLImageElement).getAttribute('src') ?? '';
      if (src && !src.includes('logo') && !src.includes('icon')) {
        const photoUrl = src.startsWith('/') ? `https://progress.edukatus.se${src}` : src;
        console.log(`[edukatus-analytics] Found container image for ${studentId}: ${photoUrl}`);
        photoCache.set(cacheKey, photoUrl);
        return photoUrl;
      }
    }

    console.log(`[edukatus-analytics] No profile image found for student ${studentId}`);
    photoCache.set(cacheKey, null);
    return null;
  } catch (err) {
    console.warn(`[edukatus-analytics] Failed to fetch photo for student ${studentId}:`, err);
    photoCache.set(cacheKey, null);
    return null;
  }
}

// -- Guardian fetching --

/**
 * Parse YYMMDD personnummer prefix, returning a full Date.
 * Assumes 20XX if YY < 70, otherwise 19XX.
 */
export function calculateAgeFromPersonnummer(pnr: string): { age: number; isOver18: boolean } | null {
  // Accept formats: YYMMDD-XXXX or YYMMDDXXXX
  const match = pnr.replace(/\s/g, '').match(/^(\d{2})(\d{2})(\d{2})[-+]?\d{4}$/);
  if (!match) return null;

  const [, yy, mm, dd] = match;
  const yearNum = parseInt(yy, 10);
  const fullYear = yearNum < 70 ? 2000 + yearNum : 1900 + yearNum;
  const month = parseInt(mm, 10) - 1; // JS 0-indexed
  const day = parseInt(dd, 10);

  const birthDate = new Date(fullYear, month, day);
  if (isNaN(birthDate.getTime())) return null;

  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }

  return { age, isOver18: age >= 18 };
}

/**
 * Fetch the guardians list page and parse the HTML table.
 * Returns all Guardian records AND a Map of studentName → personnummer.
 *
 * Table columns (0-indexed):
 * 0: Elev, 1: Personnummer, 2: Elevens adress, 3: Elevens postnr, 4: Elevens ort,
 * 5: Elevens mobil, 6: Vårdnadshavare, 7: Vårdnadshavarens adress, 8: Vårdnadshavarens postnr,
 * 9: Vårdnadshavarens ort, 10: Vårdnadshavarens e-post, 11: Vårdnadshavarens mobil,
 * 12: Vårdnadshavarens hemtelefon, 13: Vårdnadshavarens jobbtelefon
 */
export async function fetchGuardianData(school: SchoolPath): Promise<{ guardians: Guardian[]; studentPersonnummer: Map<string, string> }> {
  const base = getBaseUrl(school);
  const url = `${base}/Student/ListStudentsGuardians`;

  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching guardians`);
  }

  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const guardians: Guardian[] = [];
  const studentPersonnummer = new Map<string, string>();

  // Find the data table — typically the first table with multiple columns
  const tables = doc.querySelectorAll('table');
  let dataTable: Element | null = null;
  for (const table of tables) {
    const headerCells = table.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td');
    if (headerCells.length >= 7) {
      dataTable = table;
      break;
    }
  }

  if (!dataTable) {
    console.warn('[edukatus-analytics] Guardian table not found on page');
    return { guardians, studentPersonnummer };
  }

  // Parse tbody rows (skip header row)
  const rows = dataTable.querySelectorAll('tbody tr');
  for (const row of rows) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 7) continue;

    const getText = (index: number): string => (cells[index]?.textContent ?? '').trim();

    const studentName = getText(0);
    if (!studentName) continue;

    const personnummer = getText(1);
    const guardianName = getText(6);

    // Store personnummer for this student (overwrite is fine — same value per student)
    if (personnummer) {
      studentPersonnummer.set(studentName, personnummer);
    }

    // Only add a guardian row if there's an actual guardian name
    if (!guardianName) continue;

    guardians.push({
      studentName,
      guardianName,
      address: getText(7),
      postalCode: getText(8),
      city: getText(9),
      email: getText(10),
      mobile: getText(11),
      homePhone: getText(12),
      workPhone: getText(13),
    });
  }

  console.log(`[edukatus-analytics] Fetched ${guardians.length} guardian records, ${studentPersonnummer.size} personnummer`);
  return { guardians, studentPersonnummer };
}
