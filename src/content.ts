import type { ExtractedData, Message } from './types';
import { detectSchoolPath, fetchAbsenceExport, fetchStudentSummaries, fetchAllPeriods, fetchStudentList, fetchGradesForStudents, fetchStudentPhoto, fetchGuardianData, fetchCourseHours, fetchCounselingData, calculateAgeFromPersonnummer, scrapeStudentsFromPage, scrapeCoursesFromPage } from './fetcher';

// -- Programmatic data fetch --

function reportProgress(phase: string, percent: number, detail?: string): void {
  chrome.runtime.sendMessage({
    type: 'FETCH_STATUS',
    payload: { phase, progress: percent, detail },
  });
}

async function fetchAllData(): Promise<ExtractedData> {
  const school = detectSchoolPath();

  if (!school) {
    console.warn('[edukatus-analytics] No school path detected in URL:', window.location.href);
    return { source: 'error: no school path detected', timestamp: new Date().toISOString() };
  }
  console.log('[edukatus-analytics] Fetching data for:', school.org, '/', school.school);

  const result: ExtractedData = {
    source: `${school.org}/${school.school} (programmatic)`,
    timestamp: new Date().toISOString(),
    schoolInfo: { slug: school.school, schoolId: 0 },
  };

  try {
    // Phase 1: Fetch XLSX exports + student list in parallel (fast)
    reportProgress('Hämtar frånvarodata och elevlista...', 10);

    const [absenceRecords, studentSummaries, periodSummaries, studentListWithIds] = await Promise.all([
      fetchAbsenceExport(school, 8),
      fetchStudentSummaries(school, 2),
      fetchAllPeriods(school, (phase) => reportProgress(phase, 30)),
      fetchStudentList(school),
    ]);

    reportProgress('Frånvarodata hämtad', 50, `${absenceRecords.length} poster, ${studentSummaries.length} elever`);

    console.log('[edukatus-analytics] Fetched', absenceRecords.length, 'records,', studentSummaries.length, 'summaries,', periodSummaries.length, 'periods,', studentListWithIds.length, 'students with IDs');

    // Build student map: start with ID-mapped students, then fill from XLSX data
    const studentMap = new Map<string, { id: string; name: string; className: string }>();

    for (const s of studentListWithIds) {
      studentMap.set(s.name, { id: s.id, name: s.name, className: s.className });
    }
    for (const r of absenceRecords) {
      if (!studentMap.has(r.studentName)) {
        studentMap.set(r.studentName, { id: `name:${r.studentName}`, name: r.studentName, className: r.className });
      }
    }
    for (const s of studentSummaries) {
      if (!studentMap.has(s.studentName)) {
        studentMap.set(s.studentName, { id: `name:${s.studentName}`, name: s.studentName, className: s.className });
      }
    }

    const students = [...studentMap.values()];

    // Phase 2: Fetch grades from student programme pages (sequential, slower)
    reportProgress('Hämtar betyg...', 55, `${students.filter(s => s.id.match(/^\d+$/)).length} elever att hämta`);

    const grades = await fetchGradesForStudents(school, students, (phase) => {
      // Parse "Betyg: Name (3/21)" to get progress
      const match = phase.match(/\((\d+)\/(\d+)\)/);
      if (match) {
        const current = parseInt(match[1], 10);
        const total = parseInt(match[2], 10);
        const pct = 55 + Math.round((current / total) * 35); // 55% to 90%
        reportProgress(phase, pct);
      }
    });

    reportProgress('Bearbetar data...', 92, `${grades.length} betyg hämtade`);
    console.log('[edukatus-analytics] Fetched', grades.length, 'grades');

    // Phase 3: Fetch guardian data (sequential — one extra page load)
    reportProgress('Hämtar vårdnadshavardata...', 93);
    let guardians: import('./types').Guardian[] = [];
    let studentPersonnummer = new Map<string, string>();
    try {
      const guardianResult = await fetchGuardianData(school);
      guardians = [...guardianResult.guardians];
      studentPersonnummer = guardianResult.studentPersonnummer;
    } catch (err) {
      console.warn('[edukatus-analytics] Failed to fetch guardians (non-fatal):', err);
    }

    // Enrich students with age and isOver18 (derived from personnummer — raw personnummer not stored)
    const enrichedStudents = students.map((s) => {
      const pnr = studentPersonnummer.get(s.name);
      if (!pnr) return s;
      const ageInfo = calculateAgeFromPersonnummer(pnr);
      return {
        ...s,
        age: ageInfo?.age,
        isOver18: ageInfo?.isOver18,
      };
    });

    // Phase 4: Fetch course hours and counseling data (XLSX — fast)
    reportProgress('Hämtar kursdata och studievägledning...', 95);
    let courseHours: import('./types').CourseHours[] = [];
    let counselingData: import('./types').StudentCounselingData[] = [];
    try {
      [courseHours, counselingData] = await Promise.all([
        fetchCourseHours(school, (phase) => reportProgress(phase, 96)),
        fetchCounselingData(school, (phase) => reportProgress(phase, 97)),
      ]);
      console.log('[edukatus-analytics] Fetched', courseHours.length, 'course hours,', counselingData.length, 'counseling records');
    } catch (err) {
      console.warn('[edukatus-analytics] Failed to fetch course hours/counseling data (non-fatal):', err);
    }

    const courseSet = new Set<string>();
    for (const r of absenceRecords) {
      if (r.courseName) courseSet.add(r.courseName);
    }
    for (const g of grades) {
      if (g.courseName) courseSet.add(g.courseName);
    }

    reportProgress('Klar!', 100, `${absenceRecords.length} frånvaroposter, ${grades.length} betyg, ${enrichedStudents.length} elever`);

    return {
      ...result,
      absenceRecords,
      studentSummaries,
      periodSummaries,
      grades,
      students: enrichedStudents,
      guardians,
      courseHours,
      counselingData,
      courses: [...courseSet].map((name) => ({ id: '', name, className: '', teacher: '' })),
    };
  } catch (err) {
    console.warn('[edukatus-analytics] Fetch failed:', err);
  }

  // Fallback: scrape current page
  const students = scrapeStudentsFromPage();
  const courses = scrapeCoursesFromPage();

  return {
    ...result,
    source: `${school.org}/${school.school} (page scrape fallback)`,
    students: students.length > 0 ? students : undefined,
    courses: courses.length > 0 ? courses : undefined,
  };
}

// -- Passive page scrape --

function scrapeCurrentPage(): ExtractedData {
  const school = detectSchoolPath();
  const students = scrapeStudentsFromPage();
  const courses = scrapeCoursesFromPage();

  return {
    source: window.location.pathname,
    timestamp: new Date().toISOString(),
    schoolInfo: school ? { slug: school.school, schoolId: 0 } : undefined,
    students: students.length > 0 ? students : undefined,
    courses: courses.length > 0 ? courses : undefined,
  };
}

// -- Send data to background (waits for storage confirmation) --

function sendData(data: ExtractedData): Promise<void> {
  const hasData = !!(
    data.students?.length || data.grades?.length ||
    data.attendance?.length || data.courses?.length ||
    data.absenceRecords?.length || data.schoolInfo
  );
  if (!hasData) return Promise.resolve();

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'DATA_EXTRACTED', payload: data } satisfies Message, () => {
      resolve();
    });
  });
}

// -- Indicator --

function injectIndicator(text: string): void {
  const existing = document.getElementById('edukatus-analytics-indicator');
  if (existing) existing.remove();

  const indicator = document.createElement('div');
  indicator.id = 'edukatus-analytics-indicator';
  indicator.style.cssText = `
    position: fixed; bottom: 12px; right: 12px; z-index: 99999;
    background: #18181b; color: #a1a1aa; border: 1px solid #3f3f46;
    border-radius: 8px; padding: 8px 12px; font-size: 12px;
    font-family: system-ui, sans-serif; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    transition: opacity 0.3s;
  `;
  indicator.textContent = `Edukatus Analytics: ${text}`;
  document.body.appendChild(indicator);
  setTimeout(() => { indicator.style.opacity = '0.4'; }, 4000);
}

// -- Message handler --

chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: any) => {
  // Photo fetch request from dashboard
  if (message.type === 'FETCH_PHOTO') {
    const school = detectSchoolPath();
    if (!school || !message.studentId) {
      sendResponse({ photoUrl: null });
      return true;
    }
    fetchStudentPhoto(school, message.studentId)
      .then((photoUrl) => sendResponse({ photoUrl }))
      .catch(() => sendResponse({ photoUrl: null }));
    return true;
  }

  if (message.type === 'SCRAPE_PAGE') {
    fetchAllData().then(async (data) => {
      await sendData(data); // Wait for background to finish storing
      const counts = [
        data.absenceRecords?.length ? `${data.absenceRecords.length} frånvaroposter` : null,
        data.students?.length ? `${data.students.length} elever` : null,
        data.courses?.length ? `${data.courses.length} kurser` : null,
      ].filter(Boolean);
      injectIndicator(counts.length > 0 ? counts.join(', ') : 'Ingen data hittad');
      sendResponse({ ok: true, counts });
    }).catch((err) => {
      console.warn('[edukatus-analytics] Fetch failed:', err);
      injectIndicator(`Fel: ${err.message}`);
      sendResponse({ ok: false, error: String(err) });
    });
    return true;
  }
  return false;
});

// -- Auto-run on page load --

function init(): void {
  const data = scrapeCurrentPage();
  sendData(data);

  const school = detectSchoolPath();
  if (school) {
    injectIndicator(`Redo (${school.org}/${school.school})`);
  }
}

if (document.readyState === 'complete') {
  init();
} else {
  window.addEventListener('load', init);
}

// Re-extract on SPA-like navigation
let lastUrl = window.location.href;
const observer = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    setTimeout(init, 1000);
  }
});
observer.observe(document.body, { childList: true, subtree: true });
