// Google Apps Script web app that fronts the "Roles" / "Documents" Google Sheet.
// Copy of the code deployed in the Apps Script project bound to the spreadsheet
// (kept here for reference; the live copy is the one in script.google.com).
// Redeploy as a NEW VERSION after any change, or the /exec URL keeps serving the old code.

const ROLES_SHEET = 'Roles';
const DOCS_SHEET  = 'Documents';

function appendRoles(data) {
  const { headers, sheet } = sheetData(ROLES_SHEET);
  if (!sheet) return json({ error: 'Roles sheet not found' });
  const roles = Array.isArray(data.roles) ? data.roles : [data];
  const ids = [];
  for (const role of roles) {
    const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    const norm = normalizeRole(role, id);
    sheet.appendRow(headers.map(h => norm[h] ?? ''));
    ids.push(id);
    Utilities.sleep(100); // small pause to avoid Sheets write conflicts
  }
  return json({ success: true, count: ids.length, ids });
}

function doGet(e) {
  try {
    const a = e.parameter.action;
    if (a === 'getRoles')    return getRoles();
    if (a === 'getUrls')     return getUrls();
    if (a === 'getDocuments') return getDocuments(e);
    return json({ error: 'Unknown action: ' + a });
  } catch(err) { return json({ error: err.message }); }
}

function doPost(e) {
  try {
    const a  = e.parameter.action;
    const d  = JSON.parse(e.postData.contents || '{}');
    if (a === 'appendRole')     return appendRole(d);
    if (a === 'updateRole')     return updateRole(d);
    if (a === 'appendDocument') return appendDocument(d);
    if (a === 'appendRoles') return appendRoles(d);   // ← add this line
    return json({ error: 'Unknown action: ' + a });
  } catch(err) { return json({ error: err.message }); }
}

function json(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function sheetData(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) return { headers:[], rows:[], sheet:null };
  const last = sheet.getLastRow();
  if (last < 1) return { headers:[], rows:[], sheet };
  const vals = sheet.getRange(1, 1, last, sheet.getLastColumn()).getValues();
  return { headers: vals[0].map(String), rows: vals.slice(1), sheet };
}

function toObj(headers, row) {
  const o = {};
  headers.forEach((h,i) => o[h] = row[i] ?? '');
  return o;
}

function getRoles() {
  const { headers, rows } = sheetData(ROLES_SHEET);
  if (!headers.length) return json([]);
  const roles = rows
    .map(r => toObj(headers, r))
    .filter(r => r.Status !== 'Deleted' && r.id);
  return json(roles);
}

function getUrls() {
  const { headers, rows } = sheetData(ROLES_SHEET);
  if (!headers.length) return json([]);
  const idx = headers.indexOf('URL');
  if (idx < 0) return json([]);
  return json(rows.map(r => r[idx]).filter(Boolean));
}

function appendRole(data) {
  const { headers, sheet } = sheetData(ROLES_SHEET);
  if (!sheet) return json({ error: 'Roles sheet not found' });
  const id  = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  const norm = normalizeRole(data, id);
  sheet.appendRow(headers.map(h => norm[h] ?? ''));
  return json({ success: true, id });
}

function updateRole(data) {
  const { headers, rows, sheet } = sheetData(ROLES_SHEET);
  if (!sheet) return json({ error: 'Roles sheet not found' });
  const idIdx = headers.indexOf('id');
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][idIdx] === data.recordId) {
      if (data.status != null) {
        const c = headers.indexOf('Status');
        if (c >= 0) sheet.getRange(i+2, c+1).setValue(data.status);
      }
      if (data.docId != null && data.docId !== '') {
        const c = headers.indexOf('DocID');
        if (c >= 0) sheet.getRange(i+2, c+1).setValue(data.docId);
      }
      return json({ success: true });
    }
  }
  return json({ error: 'Record not found', recordId: data.recordId });
}

function getDocuments(e) {
  const { headers, rows } = sheetData(DOCS_SHEET);
  if (!headers.length) return json([]);
  let docs = rows.map(r => toObj(headers, r));
  if (e.parameter.roleId) docs = docs.filter(d => d.RoleID === e.parameter.roleId);
  return json(docs);
}

function appendDocument(data) {
  const { headers, sheet } = sheetData(DOCS_SHEET);
  if (!sheet) return json({ error: 'Documents sheet not found' });
  const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  const norm = {
    id,
    RoleName:    data.roleName    || data.RoleName    || '',
    RoleID:      data.roleId      || data.RoleID      || '',
    CoverLetter: data.coverLetter || data.CoverLetter || '',
    ResumeTips:  data.resumeTips  || data.ResumeTips  || '',
    NextSteps:   data.nextSteps   || data.NextSteps   || '',
    CreatedDate: new Date().toISOString().split('T')[0],
  };
  sheet.appendRow(headers.map(h => norm[h] ?? ''));
  return json({ success: true, id });
}

function normalizeRole(data, id) {
  return {
    id:            id || data.id || '',
    Title:         data.Title         || data.title         || '',
    Company:       data.Company       || data.company       || '',
    Location:      data.Location      || data.location      || '',
    Salary:        data.Salary        || data.salary        || '',
    Source:        data.Source        || data.source        || '',
    URL:           data.URL           || data.url           || '',
    Summary:       data.Summary       || data.summary       || '',
    Status:        data.Status        || data.status        || 'New',
    FetchedDate:   data.FetchedDate   || data.fetchedDate   || new Date().toISOString().split('T')[0],
    HiringContact: data.HiringContact || data.hiringContact || '',
    HiringLinkedIn:data.HiringLinkedIn|| data.hiringLinkedIn|| '',
    DocID:         data.DocID         || data.docId         || '',
  };
}
