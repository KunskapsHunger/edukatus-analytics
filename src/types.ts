// -- Domain types --

export interface Student {
  readonly id: string;
  readonly name: string;
  readonly className: string;
  readonly age?: number;            // Calculated from personnummer (not stored)
  readonly isOver18?: boolean;
}

export interface Guardian {
  readonly studentName: string;
  readonly guardianName: string;
  readonly address: string;
  readonly postalCode: string;
  readonly city: string;
  readonly email: string;
  readonly mobile: string;
  readonly homePhone: string;
  readonly workPhone: string;
}

export interface Grade {
  readonly studentId: string;
  readonly studentName: string;
  readonly courseId: string;
  readonly courseName: string;
  readonly courseCode: string;
  readonly value: string;
  readonly credits: number;       // Kurspoäng (50, 100, 150)
  readonly date: string;
  readonly isExtended: boolean;   // Utökad kurs — excluded from meritvärde
  readonly isGymnasiearbete: boolean;  // Pass/fail only — excluded from meritvärde
}

export interface AttendanceRecord {
  readonly studentId: string;
  readonly studentName: string;
  readonly totalLessons: number;
  readonly attendedLessons: number;
  readonly attendanceRate: number;
  readonly courseId: string;
  readonly courseName: string;
}

export interface Course {
  readonly id: string;
  readonly name: string;
  readonly className: string;
  readonly teacher: string;
}

// Per-student absence summary from StudentsExport
export interface StudentAbsenceSummary {
  readonly studentName: string;
  readonly className: string;
  readonly totalScheduledMinutes: number;  // Lektionstid
  readonly unexcusedMinutes: number;       // Oanmäld frånvaro
  readonly unexcusedPercent: number;       // 0-100
  readonly unexcusedCount: number;         // Oanmälda tillfällen
  readonly excusedMinutes: number;         // Anmäld frånvaro
  readonly excusedPercent: number;         // 0-100
  readonly excusedCount: number;           // Anmälda tillfällen
  readonly totalAbsencePercent: number;    // 0-100
  readonly isFlagged: boolean;             // totalAbsencePercent >= 15
}

// Period-tagged summary for term comparison
export type PeriodLabel = 'year' | 'ht' | 'vt' | 'recent' | 'prev-year' | 'prev-ht' | 'prev-vt';

export interface PeriodSummary {
  readonly period: PeriodLabel;
  readonly periodLabel: string;       // "Helår", "HT", "VT", "Senaste 2 mån"
  readonly startDate: string;
  readonly endDate: string;
  readonly summaries: readonly StudentAbsenceSummary[];
}

// Detailed per-lesson absence from DetailsExport
export interface AbsenceRecord {
  readonly studentName: string;
  readonly className: string;
  readonly absenceMinutes: number;
  readonly reportedMinutes: number;
  readonly lessonStart: string;
  readonly lessonEnd: string;
  readonly timeOfDay: string;
  readonly courseName: string;
  readonly teacher: string;
  readonly date: string;
  readonly dayOfWeek: number;
  readonly hourOfDay: number;
  readonly totalAbsenceMinutes: number;
  readonly isExcused: boolean;
}

export interface SchoolInfo {
  readonly slug: string;
  readonly schoolId: number;
}

// -- Message protocol --

export type Message =
  | { type: 'DATA_EXTRACTED'; payload: ExtractedData }
  | { type: 'GET_ALL_DATA' }
  | { type: 'ALL_DATA'; payload: StoredData }
  | { type: 'CLEAR_DATA' }
  | { type: 'DATA_CLEARED' }
  | { type: 'SCRAPE_PAGE' }
  | { type: 'FETCH_STATUS'; payload: FetchStatus }
  | { type: 'PAGE_INFO'; payload: PageInfo }
  | { type: 'GET_GUARDIANS' };

export interface FetchStatus {
  readonly phase: string;
  readonly progress: number;
  readonly error?: string;
}

export interface ExtractedData {
  readonly source: string;
  readonly timestamp: string;
  readonly students?: readonly Student[];
  readonly grades?: readonly Grade[];
  readonly attendance?: readonly AttendanceRecord[];
  readonly courses?: readonly Course[];
  readonly absenceRecords?: readonly AbsenceRecord[];
  readonly studentSummaries?: readonly StudentAbsenceSummary[];
  readonly periodSummaries?: readonly PeriodSummary[];
  readonly guardians?: readonly Guardian[];
  readonly schoolInfo?: SchoolInfo;
  readonly courseHours?: readonly CourseHours[];
  readonly counselingData?: readonly StudentCounselingData[];
}

export interface StoredData {
  readonly students: readonly Student[];
  readonly grades: readonly Grade[];
  readonly attendance: readonly AttendanceRecord[];
  readonly courses: readonly Course[];
  readonly absenceRecords: readonly AbsenceRecord[];
  readonly studentSummaries: readonly StudentAbsenceSummary[];
  readonly periodSummaries: readonly PeriodSummary[];
  readonly courseHours: readonly CourseHours[];
  readonly counselingData: readonly StudentCounselingData[];
  readonly lastUpdated: string | null;
  readonly sources: readonly string[];
  readonly schoolInfo: SchoolInfo | null;
}

export interface PageInfo {
  readonly url: string;
  readonly pageType: string;
  readonly hasData: boolean;
}

// -- Course hours (from ExportLessonTimes) --

export interface CourseHours {
  readonly courseName: string;
  readonly courseCode: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly totalLessons: number;
  readonly cancelledLessons: number;
  readonly unreportedLessons: number;
  readonly scheduledHours: number;
  readonly guaranteedHours: number;
  readonly reportingRate: number; // calculated: (total - unreported) / total * 100
}

// -- Student counseling data (from StudentCounseling/ExportToExcel) --

export interface StudentCounselingData {
  readonly studentName: string;
  readonly yearGroup: string;       // Årskull
  readonly className: string;
  readonly totalPoints: number;     // Poäng (2500)
  readonly remainingElective: number; // Kvarvarande valbara poäng
  readonly warnings: number;        // Uppmärksammande
  readonly failedPoints: number;    // Poäng F
  readonly dashPoints: number;      // Poäng --
  readonly lateAssignments: number; // Sena uppgifter
  readonly failedAssignments: number; // Underkända uppgifter
  readonly unexcusedAbsence: string;  // As string from Excel (e.g. "5,6%")
  readonly excusedAbsence: string;
  // Calculated
  readonly maxAllowedF: number;     // 250 for högskoleförberedande, 500 for yrkesprogram
  readonly fPointsRemaining: number; // maxAllowedF - failedPoints
  readonly graduationAtRisk: boolean;
  readonly programType: 'hogskoleforberedande' | 'yrkesprogram' | 'unknown';
}
