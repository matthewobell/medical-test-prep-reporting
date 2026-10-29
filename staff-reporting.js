import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, setPersistence, browserSessionPersistence, GoogleAuthProvider,
  signInWithPopup, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { reportingConfig as config } from './reporting-config.js';
import { dateRange, validateReport, total, clickRate } from './report-model.mjs';

const $ = id => document.getElementById(id);
const controls = ['range', 'platform', 'campaign', 'refresh'];
let report = null, detail = null, generation = 0, appCheck, currentUser = null, busy = false;
const app = initializeApp(config.firebase, 'staff-reporting');
const auth = getAuth(app);
const callable = httpsCallable(getFunctions(app, config.region), config.functionName);

function message(text, error = false) {
  $('status').textContent = text;
  $('status').setAttribute('role', error ? 'alert' : 'status');
}
function clearReport() {
  report = null; detail = null;
  $('cards').replaceChildren(); $('table').replaceChildren();
  $('period').textContent = ''; $('back').hidden = true;
  $('report').hidden = true;
  $('campaign').replaceChildren(new Option('All campaigns', 'all'));
}
function setBusy(value) {
  busy = value;
  controls.forEach(id => $(id).disabled = value || !currentUser);
  $('report').setAttribute('aria-busy', String(value));
}
function readableError(error) {
  const code = error?.code || '';
  if (code.includes('permission-denied')) return 'Your account does not have reporting access. Ask your administrator to enable your staff account.';
  if (code.includes('unauthenticated')) return 'Please sign out and sign in again.';
  if (code.includes('popup-blocked')) return 'Your browser blocked the Google sign-in window. Allow pop-ups for this website and try again.';
  if (code.includes('popup-closed') || code.includes('cancelled-popup')) return 'Sign-in was cancelled. You can try again.';
  if (code.includes('unauthorized-domain')) return 'Sign-in is not configured for this website. Contact your administrator.';
  if (code.includes('appCheck') || code.includes('app-check') || code.includes('failed-precondition')) return 'Website verification is not ready. Contact your administrator.';
  return 'Reports could not be loaded. Check your connection and try again. If this continues, contact your administrator.';
}
function cell(row, text, heading = false) {
  const element = document.createElement(heading ? 'th' : 'td');
  if (heading) element.scope = 'col';
  element.textContent = String(text); row.append(element); return element;
}
function render() {
  if (!report || !currentUser) return;
  const selected = $('campaign').value;
  const rows = report.rows.filter(row => (selected === 'all' || row.campaign_id === selected) &&
    (!detail || row.campaign_id === detail));
  const sums = total(rows);
  $('cards').replaceChildren();
  for (const [label, count, help] of [
    ['Ad displays', sums.displays, 'Times an ad appeared'],
    ['Ad clicks', sums.clicks, 'One click at most per displayed ad'],
    ['Continued learning', sums.continues, 'Keep Learning taps'],
    ['Click rate', clickRate(sums), 'Ad clicks ÷ ad displays']]) {
    const card = document.createElement('article'); card.className = 'card';
    const title = document.createElement('h2'); title.textContent = label;
    const number = document.createElement('div'); number.className = 'number'; number.textContent = count;
    const description = document.createElement('p'); description.textContent = help;
    card.append(title, number, description); $('cards').append(card);
  }
  $('period').textContent = `${report.start_date} through ${report.end_date} · UTC · Fetched ${new Date(report.fetched_at).toLocaleString()} (your local time)`;
  $('table-title').textContent = detail ? (rows[0]?.campaign_name || 'Campaign ads') : 'Campaign performance';
  $('table-description').textContent = detail ? 'Individual ads within this campaign.' : 'Select a campaign name to see its individual ads.';
  $('back').hidden = !detail;
  $('table').replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = 'No activity for these filters. Try another date range, platform, or campaign.';
    $('table').append(empty);
  } else {
    const table = document.createElement('table'), head = document.createElement('thead');
    const header = document.createElement('tr');
    for (const label of [detail ? 'Ad' : 'Campaign', 'Displays', 'Clicks', 'Continued', 'Click rate']) cell(header, label, true);
    head.append(header); table.append(head);
    const body = document.createElement('tbody');
    const keys = [...new Set(rows.map(row => detail ? row.creative_id : row.campaign_id))];
    for (const key of keys) {
      const group = rows.filter(row => (detail ? row.creative_id : row.campaign_id) === key);
      const sum = total(group), tr = document.createElement('tr');
      const name = detail ? group[0].creative_name : group[0].campaign_name;
      const first = cell(tr, detail ? name : '');
      if (!detail) {
        const button = document.createElement('button'); button.textContent = name;
        button.onclick = () => { detail = key; render(); $('back').focus(); };
        first.append(button);
      }
      for (const value of [sum.displays, sum.clicks, sum.continues, clickRate(sum)]) cell(tr, value);
      body.append(tr);
    }
    table.append(body); $('table').append(table);
  }
  $('report').hidden = false;
}

async function loadReport() {
  if (!currentUser) return;
  const user = currentUser, run = ++generation;
  const request = { ...dateRange(Number($('range').value)), platform: $('platform').value };
  clearReport(); setBusy(true); message('Loading your report…');
  try {
    appCheck ||= initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(config.siteKey),
      isTokenAutoRefreshEnabled: true });
    const response = await callable(request);
    if (run !== generation || currentUser?.uid !== user.uid) return;
    report = validateReport(response.data, request);
    const campaigns = new Map(report.rows.map(row => [row.campaign_id, row.campaign_name]));
    for (const [id, name] of campaigns) $('campaign').append(new Option(name, id));
    detail = null; render(); message('Report ready. Showing actual activity from the test project.');
  } catch (error) {
    if (run !== generation || currentUser?.uid !== user.uid) return;
    clearReport(); message(readableError(error), true);
  } finally {
    if (run === generation) setBusy(false);
  }
}

$('sign-in').disabled = true;
$('sign-in').onclick = async () => {
  $('sign-in').disabled = true;
  const provider = new GoogleAuthProvider(); provider.setCustomParameters({ prompt: 'select_account' });
  try { await signInWithPopup(auth, provider); }
  catch (error) { message(readableError(error), true); }
  finally { $('sign-in').disabled = false; }
};
$('sign-out').onclick = async () => {
  ++generation; clearReport(); setBusy(true);
  try { await signOut(auth); }
  catch { setBusy(false); message('Sign-out could not finish. Close this tab to end this reporting session.', true); }
};
$('range').onchange = loadReport; $('platform').onchange = loadReport;
$('campaign').onchange = () => { detail = null; render(); };
$('refresh').onclick = loadReport; $('back').onclick = () => { detail = null; render(); };

try {
  await setPersistence(auth, browserSessionPersistence);
  onAuthStateChanged(auth, user => {
    ++generation; currentUser = user; clearReport(); setBusy(false);
    $('sign-in-panel').hidden = !!user; $('sign-out').hidden = !user;
    $('account').textContent = user?.email || '';
    if (user) loadReport(); else message('Sign in with your approved staff Google account to view reports.');
  });
  $('sign-in').disabled = false;
} catch {
  clearReport(); message('Your browser could not start a secure sign-in session. Check browser storage settings and reload this page.', true);
}
