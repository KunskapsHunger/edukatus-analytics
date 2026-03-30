import type { Student, Grade, AttendanceRecord, Course, AbsenceRecord, StudentAbsenceSummary, PeriodSummary, StoredData, SchoolInfo, CourseHours, StudentCounselingData } from './types';
import { encryptData, decryptData } from './crypto';

const DB_NAME = 'edukatus-analytics';
const DB_VERSION = 8; // Migrated to single encrypted objectStore

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;

      // Drop all previous stores on upgrade
      for (const name of Array.from(db.objectStoreNames)) {
        db.deleteObjectStore(name);
      }

      db.createObjectStore('encrypted', { keyPath: '_key' });
      db.createObjectStore('meta');
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putEncrypted(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  const encrypted = await encryptData(json);
  return new Promise((resolve, reject) => {
    const tx = db.transaction('encrypted', 'readwrite');
    tx.objectStore('encrypted').put({ _key: key, data: encrypted });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getEncrypted<T>(db: IDBDatabase, key: string, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const tx = db.transaction('encrypted', 'readonly');
    const req = tx.objectStore('encrypted').get(key);
    req.onsuccess = async () => {
      const record = req.result as { _key: string; data: string } | undefined;
      if (!record) {
        resolve(fallback);
        return;
      }
      try {
        const json = await decryptData(record.data);
        resolve(JSON.parse(json) as T);
      } catch {
        resolve(fallback);
      }
    };
    req.onerror = () => resolve(fallback);
  });
}

export async function storeAllData(incoming: Partial<StoredData>): Promise<void> {
  const db = await openDB();

  const stores: Array<{ key: string; field: keyof StoredData }> = [
    { key: 'students', field: 'students' },
    { key: 'grades', field: 'grades' },
    { key: 'attendance', field: 'attendance' },
    { key: 'courses', field: 'courses' },
    { key: 'absenceRecords', field: 'absenceRecords' },
    { key: 'studentSummaries', field: 'studentSummaries' },
    { key: 'periodSummaries', field: 'periodSummaries' },
    { key: 'courseHours', field: 'courseHours' },
    { key: 'counselingData', field: 'counselingData' },
  ];

  for (const { key, field } of stores) {
    const value = incoming[field];
    if (value !== undefined) {
      await putEncrypted(db, key, value);
    }
  }

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

  const [students, grades, attendance, courses, absenceRecords, studentSummaries, periodSummaries, courseHours, counselingData] = await Promise.all([
    getEncrypted<readonly Student[]>(db, 'students', []),
    getEncrypted<readonly Grade[]>(db, 'grades', []),
    getEncrypted<readonly AttendanceRecord[]>(db, 'attendance', []),
    getEncrypted<readonly Course[]>(db, 'courses', []),
    getEncrypted<readonly AbsenceRecord[]>(db, 'absenceRecords', []),
    getEncrypted<readonly StudentAbsenceSummary[]>(db, 'studentSummaries', []),
    getEncrypted<readonly PeriodSummary[]>(db, 'periodSummaries', []),
    getEncrypted<readonly CourseHours[]>(db, 'courseHours', []),
    getEncrypted<readonly StudentCounselingData[]>(db, 'counselingData', []),
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
  return { students, grades, attendance, courses, absenceRecords, studentSummaries, periodSummaries, courseHours, counselingData, lastUpdated, sources, schoolInfo };
}

export async function clearAllData(): Promise<void> {
  const db = await openDB();
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      const tx = db.transaction('encrypted', 'readwrite');
      const req = tx.objectStore('encrypted').clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(tx.error);
    }),
    new Promise<void>((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      const req = tx.objectStore('meta').clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(tx.error);
    }),
  ]);
  db.close();
}
