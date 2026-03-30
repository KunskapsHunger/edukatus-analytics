import type { Message, ExtractedData, Guardian } from './types';
import { storeAllData, storeMeta, getAllData, clearAllData } from './storage';

// In-memory guardian cache — never persisted to IndexedDB
let cachedGuardians: Guardian[] = [];

async function handleExtractedData(data: ExtractedData): Promise<void> {
  // Cache guardians in memory only
  if (data.guardians?.length) {
    cachedGuardians = [...data.guardians];
  }

  // Load existing data, merge new data in, then store the merged result
  const existing = await getAllData();

  const merged: Parameters<typeof storeAllData>[0] = {};

  if (data.students?.length) merged.students = data.students;
  else if (existing.students.length) merged.students = existing.students;

  if (data.grades?.length) merged.grades = data.grades;
  else if (existing.grades.length) merged.grades = existing.grades;

  if (data.attendance?.length) merged.attendance = data.attendance;
  else if (existing.attendance.length) merged.attendance = existing.attendance;

  if (data.courses?.length) merged.courses = data.courses;
  else if (existing.courses.length) merged.courses = existing.courses;

  if (data.absenceRecords?.length) merged.absenceRecords = data.absenceRecords;
  else if (existing.absenceRecords.length) merged.absenceRecords = existing.absenceRecords;

  if (data.studentSummaries?.length) merged.studentSummaries = data.studentSummaries;
  else if (existing.studentSummaries.length) merged.studentSummaries = existing.studentSummaries;

  if (data.periodSummaries?.length) merged.periodSummaries = data.periodSummaries;
  else if (existing.periodSummaries.length) merged.periodSummaries = existing.periodSummaries;

  if (data.courseHours?.length) merged.courseHours = data.courseHours;
  else if (existing.courseHours.length) merged.courseHours = existing.courseHours;

  if (data.counselingData?.length) merged.counselingData = data.counselingData;
  else if (existing.counselingData.length) merged.counselingData = existing.counselingData;

  await storeAllData(merged);

  if (data.schoolInfo) await storeMeta('schoolInfo', JSON.stringify(data.schoolInfo));

  await storeMeta('lastUpdated', data.timestamp);

  const updatedData = await getAllData();
  const sources = new Set(updatedData.sources);
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
        courseHours: [], counselingData: [],
        lastUpdated: null, sources: [], schoolInfo: null,
      }}));
    return true;
  }

  if (message.type === 'GET_GUARDIANS') {
    sendResponse({ guardians: cachedGuardians });
    return false;
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
