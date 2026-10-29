import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, setPersistence, browserSessionPersistence, GoogleAuthProvider,
  signInWithPopup, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { reportingConfig as config } from './reporting-config.js';
import { dateRange, validateReport, total, clickRate, selectRows, creativeOptions } from './report-model.mjs?v=2';

const $ = id => document.getElementById(id);
const controls = ['range', 'platform', 'creative', 'campaign', 'refresh'];
let report = null, generation = 0, appCheck, currentUser = null, busy = false;
const app = initializeApp(config.firebase, 'staff-reporting');
const auth = getAuth(app);
$('test-label').hidden = config.environment !== 'test';
const callable = httpsCallable(getFunctions(app, config.region), config.functionName);

let toastTimer;
function message(text, error = false, persistent = false) {
  clearTimeout(toastTimer);
  $('status').textContent = text;
  $('status').setAttribute('role', error ? 'alert' : 'status');
  $('notification').hidden = false;
  $('notification').classList.toggle('error', error);
  if (!error && !persistent) toastTimer = setTimeout(() => { $('notification').hidden = true; }, 7000);
}
$('dismiss-status').onclick = () => { clearTimeout(toastTimer); $('notification').hidden = true; };
function clearReport() {
  report = null;
  $('cards').replaceChildren();
  $('period').textContent = '';
  $('report').hidden = true;
  $('campaign').replaceChildren(new Option('All campaigns', 'all'));
  $('creative').replaceChildren(new Option('All creatives', 'all'));
}
function setBusy(value) {
  busy = value;
  controls.forEach(id => $(id).disabled = value || !currentUser || (['campaign', 'creative'].includes(id) && !report));
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
function updateCreatives() {
  $('creative').replaceChildren(new Option('All creatives', 'all'));
  if (!report) return;
  for (const option of creativeOptions(report.rows, $('campaign').value)) {
    $('creative').append(new Option(option.label, option.value));
  }
}
function render() {
  if (!report || !currentUser) return;
  const rows = selectRows(report.rows, $('campaign').value, $('creative').value);
  const sums = total(rows);
  $('cards').replaceChildren();
  for (const [label, count, help] of [
    ['Ad Displays', sums.displays.toLocaleString(), 'Number of times an ad appeared'],
    ['Ad Clicks', sums.clicks.toLocaleString(), 'At most one click per displayed ad'],
    ['Continued Learning', sums.continues.toLocaleString(), 'Number of Keep Learning taps'],
    ['Click Rate', clickRate(sums), 'Ad clicks divided by ad displays']]) {
    const card = document.createElement('article'); card.className = 'card';
    const title = document.createElement('h2'); title.textContent = label;
    const number = document.createElement('div'); number.className = 'number'; number.textContent = count;
    const description = document.createElement('p'); description.textContent = help;
    card.append(title, description, number); $('cards').append(card);
  }
  const formatDay = day => new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  }).format(new Date(day + 'T00:00:00Z'));
  const fetched = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(new Date(report.fetched_at));
  $('period').textContent = `${formatDay(report.start_date)} through ${formatDay(report.end_date)} | UTC | Last refreshed ${fetched} (local time)`;
  $('report').hidden = false;
  if (!rows.length) message('No activity for these filters. Try another date range, platform, campaign, or creative.', false, true);
}

async function loadReport() {
  if (!currentUser) return;
  const user = currentUser, run = ++generation;
  const request = { ...dateRange(Number($('range').value)), platform: $('platform').value };
  clearReport(); setBusy(true); message('Loading your reportâ€¦', false, true);
  try {
    appCheck ||= initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(config.siteKey),
      isTokenAutoRefreshEnabled: true });
    const response = await callable(request);
    if (run !== generation || currentUser?.uid !== user.uid) return;
    report = validateReport(response.data, request);
    const campaigns = new Map(report.rows.map(row => [row.campaign_id, row.campaign_name]));
    for (const [id, name] of campaigns) $('campaign').append(new Option(name, id));
    updateCreatives(); render();
    if (report.rows.length) message('Report refreshed. Showing activity from the test project.');
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
$('campaign').onchange = () => { updateCreatives(); render(); };
$('creative').onchange = render;
$('refresh').onclick = loadReport;

try {
  await setPersistence(auth, browserSessionPersistence);
  onAuthStateChanged(auth, user => {
    ++generation; currentUser = user; clearReport(); setBusy(false);
    $('sign-in-panel').hidden = !!user; $('sign-out').hidden = !user;
    $('account').textContent = user?.email ? 'Signed in: ' + user.email : 'Staff reporting';
    if (user) loadReport(); else message('Sign in with your approved Google account. Your administrator controls reporting access.', false, true);
  });
  $('sign-in').disabled = false;
} catch {
  clearReport(); message('Your browser could not start a secure sign-in session. Check browser storage settings and reload this page.', true);
}
