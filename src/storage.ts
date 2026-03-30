import type { Student, Grade, AttendanceRecord, Course, AbsenceRecord, StudentAbsenceSummary, PeriodSummary, StoredData, SchoolInfo, Guardian, CourseHours, StudentCounselingData } from './types';

const DB_NAME = 'edukatus-analytics';
const DB_VERSION = 7; // Added courseHours and counselingData stores

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 7) {
        for (const name of ['students', 'grades', 'attendance', 'courses', 'absenceRecords', 'studentSummaries', 'periodSummaries', 'guardians', 'courseHours', 'counselingData', 'meta']) {
          if (db.objectStoreNames.contains(name)) {
            db.deleteObjectStore(name);
          }
        }
      }

      if (!db.objectStoreNames.contains('students')) {
        db.createObjectStore('students', { keyPath: '_key' });
      }
      if (!db.objectStoreNames.contains('grades')) {
        db.createObjectStore('grades', { keyPath: '_key' });
      }
      if (!db.objectStoreNames.contains('attendance')) {
        db.createObjectStore('attendance', { keyPath: '_key' });
      }
      if (!db.objectStoreNames.contains('courses')) {
        db.createObjectStore('courses', { keyPath: '_key' });
      }
      if (!db.objectStoreNames.contains('absenceRecords')) {
        db.createObjectStore('absenceRecords', { keyPath: '_key' });
      }
      if (!db.objectStoreNames.contains('studentSummaries')) {
        db.createObjectStore('studentSummaries', { keyPath: '_key' });
      }
      // Period summaries: keyed by period label (year, ht, vt, recent)
      if (!db.objectStoreNames.contains('periodSummaries')) {
        db.createObjectStore('periodSummaries', { keyPath: '_key' });
      }
      // Guardians: keyed by studentName::guardianName (lowercase)
      if (!db.objectStoreNames.contains('guardians')) {
        db.createObjectStore('guardians', { keyPath: '_key' });
      }
      // Course hours: keyed by courseCode (lowercase)
      if (!db.objectStoreNames.contains('courseHours')) {
        db.createObjectStore('courseHours', { keyPath: '_key' });
      }
      // Counseling data: keyed by studentName (lowercase)
      if (!db.objectStoreNames.contains('counselingData')) {
        db.createObjectStore('counselingData', { keyPath: '_key' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txPut<T>(db: IDBDatabase, storeName: string, items: readonly T[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const item of items) store.put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function txGetAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

function txClear(db: IDBDatabase, storeName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const request = tx.objectStore(storeName).clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Dedup key generators
function absenceKey(r: AbsenceRecord): string {
  return `${r.studentName.toLowerCase()}::${r.courseName.toLowerCase()}::${r.lessonStart}`;
}

export async function storeStudents(students: readonly Student[]): Promise<void> {
  const db = await openDB();
  await txPut(db, 'students', students.map((s) => ({ ...s, _key: s.name.toLowerCase().trim() })));
  db.close();
}

export async function storeGrades(grades: readonly Grade[]): Promise<void> {
  const db = await openDB();
  await txPut(db, 'grades', grades.map((g) => ({
    ...g, _key: `${g.studentName.toLowerCase()}::${g.courseName.toLowerCase()}::${g.value.toUpperCase()}`,
  })));
  db.close();
}

export async function storeAttendance(records: readonly AttendanceRecord[]): Promise<void> {
  const db = await openDB();
  await txPut(db, 'attendance', records.map((a) => ({
    ...a, _key: `${a.studentName.toLowerCase()}::${a.courseName.toLowerCase()}`,
  })));
  db.close();
}

export async function storeCourses(courses: readonly Course[]): Promise<void> {
  const db = await openDB();
  await txPut(db, 'courses', courses.map((c) => ({ ...c, _key: c.name.toLowerCase().trim() })));
  db.close();
}

export async function storeAbsenceRecords(records: readonly AbsenceRecord[]): Promise<void> {
  const db = await openDB();
  await txPut(db, 'absenceRecords', records.map((r) => ({ ...r, _key: absenceKey(r) })));
  db.close();
}

export async function storeStudentSummaries(summaries: readonly StudentAbsenceSummary[]): Promise<void> {
  const db = await openDB();
  await txPut(db, 'studentSummaries', summaries.map((s) => ({ ...s, _key: s.studentName.toLowerCase().trim() })));
  db.close();
}

export async function storePeriodSummaries(periods: readonly PeriodSummary[]): Promise<void> {
  const db = await openDB();
  await txPut(db, 'periodSummaries', periods.map((p) => ({ ...p, _key: p.period })));
  db.close();
}

export async function storeGuardians(guardians: readonly Guardian[]): Promise<void> {
  const db = await openDB();
  await txPut(db, 'guardians', guardians.map((g) => ({
    ...g,
    _key: `${g.studentName.toLowerCase()}::${g.guardianName.toLowerCase()}`,
  })));
  db.close();
}

export async function storeCourseHours(courses: readonly CourseHours[]): Promise<void> {
  const db = await openDB();
  await txPut(db, 'courseHours', courses.map((c) => ({
    ...c,
    _key: (c.courseCode || c.courseName).toLowerCase().trim(),
  })));
  db.close();
}

export async function storeCounselingData(students: readonly StudentCounselingData[]): Promise<void> {
  const db = await openDB();
  await txPut(db, 'counselingData', students.map((s) => ({
    ...s,
    _key: s.studentName.toLowerCase().trim(),
  })));
  db.close();
}

export async function storeMeta(key: string, value: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  await new Promise<void>((r, j) => { tx.oncomplete = () => r(); tx.onerror = () => j(tx.error); });
  db.close();
}

export async function getAllData(): Promise<StoredData> {
  const db = await openDB();

  const [students, grades, attendance, courses, absenceRecords, studentSummaries, periodSummaries, guardians, courseHours, counselingData] = await Promise.all([
    txGetAll<Student>(db, 'students'),
    txGetAll<Grade>(db, 'grades'),
    txGetAll<AttendanceRecord>(db, 'attendance'),
    txGetAll<Course>(db, 'courses'),
    txGetAll<AbsenceRecord>(db, 'absenceRecords'),
    txGetAll<StudentAbsenceSummary>(db, 'studentSummaries'),
    txGetAll<PeriodSummary>(db, 'periodSummaries'),
    txGetAll<Guardian>(db, 'guardians'),
    txGetAll<CourseHours>(db, 'courseHours'),
    txGetAll<StudentCounselingData>(db, 'counselingData'),
  ]);

  const getMeta = (key: string) => new Promise<string | null>((resolve) => {
    const tx = db.transaction('meta', 'readonly');
    const req = tx.objectStore('meta').get(key);
    req.onsuccess = () => resolve((req.result as string) ?? null);
    req.onerror = () => resolve(null);
  });

  const lastUpdated = await getMeta('lastUpdated');
  const sourcesRaw = await getMeta('sources');
  const schoolInfoRaw = await getMeta('schoolInfo');

  let sources: string[] = [];
  try { sources = JSON.parse(sourcesRaw ?? '[]'); } catch {}

  let schoolInfo: SchoolInfo | null = null;
  try { schoolInfo = JSON.parse(schoolInfoRaw ?? 'null'); } catch {}

  db.close();
  return { students, grades, attendance, courses, absenceRecords, studentSummaries, periodSummaries, guardians, courseHours, counselingData, lastUpdated, sources, schoolInfo };
}

export async function clearAllData(): Promise<void> {
  const db = await openDB();
  await Promise.all([
    txClear(db, 'students'),
    txClear(db, 'grades'),
    txClear(db, 'attendance'),
    txClear(db, 'courses'),
    txClear(db, 'absenceRecords'),
    txClear(db, 'studentSummaries'),
    txClear(db, 'periodSummaries'),
    txClear(db, 'guardians'),
    txClear(db, 'courseHours'),
    txClear(db, 'counselingData'),
    txClear(db, 'meta'),
  ]);
  db.close();
}
