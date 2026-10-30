import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, setPersistence, browserSessionPersistence, GoogleAuthProvider,
  signInWithPopup, onAuthStateChanged, signOut, sendSignInLinkToEmail,
  isSignInWithEmailLink, signInWithEmailLink } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { reportingConfig as config } from './reporting-config.js';
import { dateRange, validateReport, total, clickRate, selectRows, creativeOptions } from './report-model.mjs?v=3';

const $ = id => document.getElementById(id);
const heading = document.querySelector('.identity h1');
const controls = ['range', 'platform', 'creative', 'campaign', 'refresh'];
let report = null, generation = 0, appCheck, currentUser = null, busy = false;
const app = initializeApp(config.firebase, 'staff-reporting');
const auth = getAuth(app);
const callable = httpsCallable(getFunctions(app, config.region), config.functionName);
const emailStorageKey = 'mtp-reporting-email';
let emailLink = isSignInWithEmailLink(auth, window.location.href) ? window.location.href : '';
let authReady = false, authBusy = false;
function setAuthBusy(value) {
  authBusy = value;
  for (const id of ['sign-in', 'sign-in-email', 'email-sign-in', 'new-email-link']) {
    $(id).disabled = !authReady || value;
  }
}
function resetEmailLink() {
  emailLink = '';
  window.history.replaceState(null, '', window.location.pathname);
  try { window.sessionStorage.removeItem(emailStorageKey); } catch {}
  $('email-sign-in').textContent = 'Email me a sign-in link';
  $('email-sign-in-help').textContent = 'We will email you a sign-in link. No password or Google account is needed.';
  $('new-email-link').hidden = true;
}
function emailError(error) {
  const code = error?.code || '';
  if (code.includes('expired-action-code') || code.includes('invalid-action-code'))
    return 'This link has expired or has already been used. Request a new sign-in link.';
  if (code.includes('invalid-email') || code.includes('invalid-credential'))
    return 'Check your email address. To finish signing in, use the address that received this link.';
  if (code.includes('too-many-requests') || code.includes('quota-exceeded'))
    return 'Too many sign-in requests. Please wait and try again later.';
  if (code.includes('user-disabled')) return 'This account is disabled. Contact your administrator.';
  if (code.includes('operation-not-allowed') || code.includes('unauthorized-continue-uri'))
    return 'Email sign-in is not configured yet. Contact your administrator.';
  return 'Email sign-in could not finish. Check your connection and try again, or request a new link.';
}
$('email-sign-in-form').onsubmit = async event => {
  event.preventDefault();
  if (!authReady || authBusy) return;
  const email = $('sign-in-email').value.trim();
  if (!email || !$('sign-in-email').checkValidity()) {
    $('sign-in-email').reportValidity(); return;
  }
  setAuthBusy(true);
  try {
    if (emailLink) {
      const result = await signInWithEmailLink(auth, email, emailLink);
      resetEmailLink();
      $('sign-in-email').value = '';
      handleAuthUser(result.user);
    } else {
      await sendSignInLinkToEmail(auth, email, {
        url: 'https://matthewobell.github.io/medical-test-prep-reporting/staff-reporting.html',
        handleCodeInApp: true
      });
      try { window.sessionStorage.setItem(emailStorageKey, email); } catch {}
      message('Sign-in link sent. Check your inbox and spam folder. Open the newest link to continue. Reporting access still requires administrator approval.', false, true);
    }
  } catch (error) {
    message(emailError(error), true);
  } finally { setAuthBusy(false); }
};
$('new-email-link').onclick = () => {
  if (authBusy) return;
  resetEmailLink();
  message('Enter your email address to request a new sign-in link.', false, true);
};


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
  heading.textContent = 'Campaign Reporting';
  $('dashboard-content').hidden = true;
  $('sign-in-panel').hidden = false;
  $('portal-page').setAttribute('data-view', 'entry');
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
  heading.textContent = 'Campaign Dashboard: ' + (report.scope.type === 'sponsor' ? report.scope.name : 'All');
  const rows = selectRows(report.rows, $('campaign').value, $('creative').value);
  const sums = total(rows);
  $('cards').replaceChildren();
  for (const [label, count, help] of [
    ['Ad Displays', sums.displays.toLocaleString(), 'Number of times an ad was shown to a user'],
    ['Ad Clicks', sums.clicks.toLocaleString(), 'At most one click per displayed ad'],
    ['Continued Learning', sums.continues.toLocaleString(), 'Number of Keep Learning taps'],
    ['Click Rate', clickRate(sums), 'Ad clicks divided by ad displays']]) {
    const card = document.createElement('article'); card.className = 'card';
    const title = document.createElement('h2'); title.textContent = label;
    const number = document.createElement('div'); number.className = 'number'; number.textContent = count;
    const description = document.createElement('p'); description.textContent = help;
    card.append(title, description, number); $('cards').append(card);
  }
  const AP_MONTHS = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
  const formatDay = day => {
    const d = new Date(day + 'T00:00:00Z');
    return `${AP_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  };
  const when = new Date(report.fetched_at);
  const fetched = `${AP_MONTHS[when.getMonth()]} ${when.getDate()}, ${when.getFullYear()}, ` +
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(when);
  $('period').textContent = `${formatDay(report.start_date)} through ${formatDay(report.end_date)} | UTC | Fetched ${fetched} (local time)`;
  $('report').hidden = false;
  $('dashboard-content').hidden = false;
  $('sign-in-panel').hidden = true;
  $('portal-page').setAttribute('data-view', 'dashboard');
  if (!rows.length) message('No activity for these filters. Try another date range, platform, campaign, or creative.', false, true);
}

async function loadReport() {
  if (!currentUser) return;
  const user = currentUser, run = ++generation;
  const request = { ...dateRange(Number($('range').value)), platform: $('platform').value };
  clearReport(); $('sign-in-panel').hidden = true; setBusy(true); message('Loading your report', false, true);
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
  if (!authReady || authBusy) return;
  setAuthBusy(true);
  if (emailLink) resetEmailLink();
  const provider = new GoogleAuthProvider(); provider.setCustomParameters({ prompt: 'select_account' });
  try { await signInWithPopup(auth, provider); }
  catch (error) { message(readableError(error), true); }
  finally { setAuthBusy(false); }
};
$('sign-out').onclick = async () => {
  ++generation; clearReport(); setBusy(true);
  resetEmailLink(); $('sign-in-email').value = '';
  try { await signOut(auth); }
  catch { setBusy(false); message('Sign-out could not finish. Close this tab to end this reporting session.', true); }
};
$('range').onchange = loadReport; $('platform').onchange = loadReport;
$('campaign').onchange = () => { updateCreatives(); render(); };
$('creative').onchange = render;
$('refresh').onclick = loadReport;

function handleAuthUser(user) {
  ++generation; currentUser = user; clearReport(); setBusy(false);
  $('sign-out').hidden = !user;
  $('account').textContent = user?.email ? 'Signed in: ' + user.email : 'Staff reporting';
  if (emailLink) {
    $('email-sign-in').textContent = 'Confirm email and sign in';
    $('email-sign-in-help').textContent = 'Enter the email address that received this link to finish signing in.';
    $('new-email-link').hidden = false;
    message('Confirm the email address that received your sign-in link.', false, true);
  } else if (user) {
    loadReport();
  } else {
    message('Sign in with your email or Google account. Your administrator controls reporting access.', false, true);
  }
}
try {
  await setPersistence(auth, browserSessionPersistence);
  if (emailLink) {
    try { $('sign-in-email').value = window.sessionStorage.getItem(emailStorageKey) || ''; } catch {}
  }
  onAuthStateChanged(auth, handleAuthUser);
  authReady = true; setAuthBusy(false);
} catch {
  clearReport(); message('Your browser could not start a secure sign-in session. Check browser storage settings and reload this page.', true);
}
