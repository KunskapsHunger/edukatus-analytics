// Paste this in the Edukatus Analytics dashboard console (F12 → Console)
// It injects realistic fake data for screenshots

const fakeStudents = [
  { name: 'Emma Lindström', className: 'NA24', id: '90001' },
  { name: 'Oscar Bergqvist', className: 'NA24', id: '90002' },
  { name: 'Alma Johansson', className: 'NA24', id: '90003' },
  { name: 'Hugo Nilsson', className: 'NA24', id: '90004' },
  { name: 'Wilma Eriksson', className: 'NA24', id: '90005' },
  { name: 'Liam Andersson', className: 'TE24', id: '90006' },
  { name: 'Saga Pettersson', className: 'TE24', id: '90007' },
  { name: 'Elias Svensson', className: 'TE24', id: '90008' },
  { name: 'Maja Larsson', className: 'TE24', id: '90009' },
  { name: 'Noah Gustafsson', className: 'TE24', id: '90010' },
  { name: 'Astrid Olsson', className: 'IT24', id: '90011' },
  { name: 'William Persson', className: 'IT24', id: '90012' },
  { name: 'Freja Magnusson', className: 'IT24', id: '90013' },
  { name: 'Lucas Fredriksson', className: 'IT24', id: '90014' },
  { name: 'Ebba Henriksson', className: 'IT24', id: '90015' },
  { name: 'Oliver Björk', className: 'IT24', id: '90016' },
  { name: 'Ella Sandberg', className: 'IT24', id: '90017' },
  { name: 'Filip Holm', className: 'IT24', id: '90018' },
  { name: 'Vera Lundgren', className: 'NA24', id: '90019' },
  { name: 'Axel Wallin', className: 'TE24', id: '90020' },
  { name: 'Selma Nyström', className: 'NA24', id: '90021' },
  { name: 'Leo Ekström', className: 'TE24', id: '90022' },
  { name: 'Ines Dahlberg', className: 'IT24', id: '90023' },
  { name: 'Theo Sjöberg', className: 'IT24', id: '90024' },
];

const courses = [
  'Matematik 2c', 'Engelska 6', 'Svenska 2', 'Fysik 1a', 'Kemi 1',
  'Historia 1b', 'Samhällskunskap 1b', 'Biologi 1', 'Idrott och hälsa 1',
  'Programmering 1', 'Webbutveckling 1', 'Datorteknik 1a', 'Entreprenörskap',
  'Religionskunskap 1', 'Naturkunskap 1a1',
];

const days = ['Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag'];
const gradeValues = ['A', 'B', 'C', 'D', 'E', 'F'];
const gradeWeights = [0.08, 0.15, 0.25, 0.22, 0.20, 0.10]; // realistic distribution

function weightedRandom(values, weights) {
  const r = Math.random();
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += weights[i];
    if (r < sum) return values[i];
  }
  return values[values.length - 1];
}

function randomDate(start, end) {
  const d = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
  return d.toISOString().split('T')[0];
}

// Generate absence summaries with realistic distribution
const studentSummaries = fakeStudents.map(s => {
  // Some students have high absence, most are moderate
  const isHighRisk = Math.random() < 0.25;
  const isMedium = Math.random() < 0.3;
  const totalPct = isHighRisk ? 20 + Math.random() * 35 : isMedium ? 10 + Math.random() * 10 : Math.random() * 8;
  const unexRatio = 0.2 + Math.random() * 0.5;
  const unexPct = totalPct * unexRatio;
  const exPct = totalPct - unexPct;
  const scheduled = 4000 + Math.random() * 3000;

  return {
    studentName: s.name,
    className: s.className,
    totalScheduledMinutes: Math.round(scheduled),
    unexcusedMinutes: Math.round(scheduled * unexPct / 100),
    unexcusedPercent: Math.round(unexPct * 10) / 10,
    unexcusedCount: Math.round(unexPct / 2),
    excusedMinutes: Math.round(scheduled * exPct / 100),
    excusedPercent: Math.round(exPct * 10) / 10,
    excusedCount: Math.round(exPct / 2),
    totalAbsencePercent: Math.round(totalPct * 10) / 10,
    isFlagged: totalPct >= 15,
  };
});

// Generate detailed absence records
const absenceRecords = [];
const startDate = new Date('2025-08-20');
const endDate = new Date('2026-03-28');

for (const s of fakeStudents) {
  const summary = studentSummaries.find(ss => ss.studentName === s.name);
  const numRecords = Math.round(summary.totalAbsencePercent * 2);

  for (let i = 0; i < numRecords; i++) {
    const date = randomDate(startDate, endDate);
    const d = new Date(date);
    const dayOfWeek = (d.getDay() + 6) % 7;
    if (dayOfWeek >= 5) continue; // skip weekends

    const hour = 8 + Math.floor(Math.random() * 8);
    const course = courses[Math.floor(Math.random() * courses.length)];
    const isExcused = Math.random() < 0.4;
    const mins = [30, 40, 50, 60, 80][Math.floor(Math.random() * 5)];

    absenceRecords.push({
      studentName: s.name,
      className: s.className,
      absenceMinutes: isExcused ? 0 : mins,
      reportedMinutes: isExcused ? mins : 0,
      lessonStart: `${date} ${String(hour).padStart(2, '0')}:${Math.random() < 0.5 ? '00' : '30'}`,
      lessonEnd: `${date} ${String(hour + 1).padStart(2, '0')}:${Math.random() < 0.5 ? '00' : '30'}`,
      timeOfDay: `${String(hour).padStart(2, '0')}:${Math.random() < 0.5 ? '00' : '30'}`,
      courseName: course,
      teacher: ['A. Lindberg', 'M. Ekström', 'S. Brodd', 'K. Pålsson', 'E. Jarhed'][Math.floor(Math.random() * 5)],
      date: date,
      dayOfWeek: dayOfWeek,
      hourOfDay: hour,
      totalAbsenceMinutes: mins,
      isExcused: isExcused,
    });
  }
}

// Generate grades
const grades = [];
for (const s of fakeStudents) {
  const summary = studentSummaries.find(ss => ss.studentName === s.name);
  // High absence students tend to get worse grades
  const gradeShift = summary.totalAbsencePercent > 25 ? [0.03, 0.08, 0.18, 0.28, 0.28, 0.15] : gradeWeights;
  const numCourses = 5 + Math.floor(Math.random() * 6);

  for (let i = 0; i < numCourses; i++) {
    grades.push({
      studentId: s.id,
      studentName: s.name,
      courseId: '',
      courseName: courses[i % courses.length],
      courseCode: '',
      value: weightedRandom(gradeValues, gradeShift),
      credits: [50, 100, 100, 100, 150][Math.floor(Math.random() * 5)],
      date: randomDate(new Date('2024-06-01'), new Date('2026-01-30')),
      isExtended: false,
      isGymnasiearbete: false,
    });
  }
}

// Generate period summaries (HT vs VT)
function makePeriodSummaries(period, label, start, end) {
  return {
    period: period,
    periodLabel: label,
    startDate: start,
    endDate: end,
    summaries: fakeStudents.map(s => {
      const base = studentSummaries.find(ss => ss.studentName === s.name);
      const variation = (Math.random() - 0.5) * 10;
      const totalPct = Math.max(0, base.totalAbsencePercent + variation);
      return { ...base, totalAbsencePercent: Math.round(totalPct * 10) / 10, isFlagged: totalPct >= 15 };
    }),
  };
}

const periodSummaries = [
  makePeriodSummaries('year', 'Helår', '2025-08-15', '2026-03-28'),
  makePeriodSummaries('ht', 'HT (Hösttermin)', '2025-08-15', '2025-12-31'),
  makePeriodSummaries('vt', 'VT (Vårtermin)', '2026-01-01', '2026-03-28'),
  makePeriodSummaries('recent', 'Senaste 2 månader', '2026-01-28', '2026-03-28'),
];

// Generate counseling data
const counselingData = fakeStudents.map(s => {
  const summary = studentSummaries.find(ss => ss.studentName === s.name);
  const isNA = s.className.startsWith('NA');
  const maxF = isNA ? 250 : 500;
  const failedPoints = summary.totalAbsencePercent > 25 ? Math.round(Math.random() * 200) : summary.totalAbsencePercent > 15 ? Math.round(Math.random() * 100) : 0;

  return {
    studentName: s.name,
    yearGroup: '2024',
    className: s.className,
    totalPoints: 2500,
    remainingElective: 0,
    warnings: summary.totalAbsencePercent > 20 ? Math.floor(Math.random() * 4) : 0,
    failedPoints: failedPoints,
    dashPoints: 0,
    lateAssignments: Math.floor(Math.random() * (summary.totalAbsencePercent > 15 ? 15 : 5)),
    failedAssignments: Math.floor(Math.random() * (summary.totalAbsencePercent > 20 ? 5 : 1)),
    unexcusedAbsence: summary.unexcusedPercent + '%',
    excusedAbsence: summary.excusedPercent + '%',
    maxAllowedF: maxF,
    fPointsRemaining: maxF - failedPoints,
    graduationAtRisk: failedPoints > maxF * 0.7,
    programType: isNA ? 'hogskoleforberedande' : 'yrkesprogram',
  };
});

// Generate course hours
const courseHours = courses.map(c => ({
  courseName: '25/26 ' + c,
  courseCode: c.substring(0, 3).toUpperCase() + c.substring(0, 3).toUpperCase() + '01',
  startDate: '2025-08-21',
  endDate: '2026-06-11',
  totalLessons: 40 + Math.floor(Math.random() * 40),
  cancelledLessons: Math.floor(Math.random() * 3),
  unreportedLessons: Math.floor(Math.random() * 10),
  scheduledHours: 60 + Math.floor(Math.random() * 40),
  guaranteedHours: 50 + Math.floor(Math.random() * 40),
  reportingRate: 75 + Math.floor(Math.random() * 25),
}));

// Send to background as if fetched from Progress
const payload = {
  source: 'demo/testskolan (test data)',
  timestamp: new Date().toISOString(),
  students: fakeStudents,
  grades: grades,
  absenceRecords: absenceRecords,
  studentSummaries: studentSummaries,
  periodSummaries: periodSummaries,
  courseHours: courseHours,
  counselingData: counselingData,
  courses: courses.map(c => ({ id: '', name: c, className: '', teacher: '' })),
  schoolInfo: { slug: 'testskolan', schoolId: 0 },
};

chrome.runtime.sendMessage({ type: 'DATA_EXTRACTED', payload: payload }, (resp) => {
  console.log('Test data injected:', resp);
  console.log(`${fakeStudents.length} students, ${absenceRecords.length} absence records, ${grades.length} grades`);
  console.log('Reload the dashboard to see the data.');
  setTimeout(() => location.reload(), 1500);
});
