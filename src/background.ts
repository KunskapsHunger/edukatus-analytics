import type { Message, ExtractedData } from './types';
import { storeStudents, storeGrades, storeAttendance, storeCourses, storeAbsenceRecords, storeStudentSummaries, storePeriodSummaries, storeGuardians, storeCourseHours, storeCounselingData, storeMeta, getAllData, clearAllData } from './storage';

async function handleExtractedData(data: ExtractedData): Promise<void> {
  if (data.students?.length) await storeStudents(data.students);
  if (data.grades?.length) await storeGrades(data.grades);
  if (data.attendance?.length) await storeAttendance(data.attendance);
  if (data.courses?.length) await storeCourses(data.courses);
  if (data.absenceRecords?.length) await storeAbsenceRecords(data.absenceRecords);
  if (data.studentSummaries?.length) await storeStudentSummaries(data.studentSummaries);
  if (data.periodSummaries?.length) await storePeriodSummaries(data.periodSummaries);
  if (data.guardians?.length) await storeGuardians(data.guardians);
  if (data.courseHours?.length) await storeCourseHours(data.courseHours);
  if (data.counselingData?.length) await storeCounselingData(data.counselingData);
  if (data.schoolInfo) await storeMeta('schoolInfo', JSON.stringify(data.schoolInfo));

  await storeMeta('lastUpdated', data.timestamp);

  const allData = await getAllData();
  const sources = new Set(allData.sources);
  sources.add(data.source);
  await storeMeta('sources', JSON.stringify([...sources]));
}

// Open dashboard tab on icon click
chrome.action.onClicked.addListener(() => {
  const dashboardUrl = chrome.runtime.getURL('dashboard.html');
  chrome.tabs.query({ url: dashboardUrl }, (tabs) => {
    if (tabs.length > 0 && tabs[0].id) {
      chrome.tabs.update(tabs[0].id, { active: true });
    } else {
      chrome.tabs.create({ url: dashboardUrl });
    }
  });
});

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  // Forward progress updates to the dashboard tab
  if (message.type === 'FETCH_STATUS') {
    const dashboardUrl = chrome.runtime.getURL('dashboard.html');
    chrome.tabs.query({ url: dashboardUrl }, (tabs) => {
      for (const tab of tabs) {
        if (tab.id) chrome.tabs.sendMessage(tab.id, message);
      }
    });
    return false; // No async response needed
  }

  if (message.type === 'DATA_EXTRACTED') {
    handleExtractedData(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === 'GET_ALL_DATA') {
    getAllData()
      .then((data) => sendResponse({ type: 'ALL_DATA', payload: data }))
      .catch(() => sendResponse({ type: 'ALL_DATA', payload: {
        students: [], grades: [], attendance: [], courses: [],
        absenceRecords: [], studentSummaries: [], periodSummaries: [],
        guardians: [], courseHours: [], counselingData: [],
        lastUpdated: null, sources: [], schoolInfo: null,
      }}));
    return true;
  }

  if (message.type === 'CLEAR_DATA') {
    clearAllData()
      .then(() => sendResponse({ type: 'DATA_CLEARED' }))
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  }

  if (message.type === 'SCRAPE_PAGE' || message.type === 'FETCH_PHOTO') {
    chrome.tabs.query({ url: 'https://progress.edukatus.se/*' }, (tabs) => {
      if (tabs.length > 0 && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, message, sendResponse);
      } else {
        sendResponse(message.type === 'FETCH_PHOTO' ? { photoUrl: null } : { ok: false, error: 'No Progress tab open' });
      }
    });
    return true;
  }
});
