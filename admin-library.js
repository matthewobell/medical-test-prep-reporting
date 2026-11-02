import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, setPersistence, browserSessionPersistence, onAuthStateChanged, GoogleAuthProvider,
  signInWithPopup, signOut, sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { reportingConfig as config } from './reporting-config.js';

const $ = id => document.getElementById(id);
const app = initializeApp(config.firebase, 'staff-reporting');
const auth = getAuth(app);
const fetchLibrary = httpsCallable(getFunctions(app, config.region), 'get_admin_library');
let user = null, catalog = null, generation = 0, appCheck, timer, ready = false, authBusy = false;
let section = 'sponsors', selected = null;
let emailLink = isSignInWithEmailLink(auth, window.location.href) ? window.location.href : '';
const labels = { name:'Name', sponsor_id:'Sponsor', campaign_id:'Campaign', enabled:'Enabled', approved:'Approved',
  logo_url:'Logo link', placement:'Placement', exam:'Exam', module:'Module', start_at:'Starts (inclusive)', end_at:'Ends (exclusive)',
  platforms:'Platforms', exclusive:'Exclusive booking', share_schedule:'Campaign exposure share schedule',
  creative_overrides:'Exam/module creative overrides', rotation_weight:'Creative rotation weight', eyebrow_text:'Eyebrow text',
  headline:'Headline', body_text:'Body text', cta_text:'Button text', click_url:'Destination link', disclaimer_text:'Disclosure',
  media_type:'Media type', image_url:'Image link', video_url:'Video link', video_poster_image_url:'Video poster link',
  video_muted_by_default:'Video muted by default' };
const fields = {
  sponsors:['name','enabled','logo_url'],
  campaigns:['name','sponsor_id','approved','enabled','start_at','end_at','platforms','placement','exam','module','exclusive','share_schedule','creative_overrides'],
  creatives:['name','campaign_id','approved','enabled','start_at','end_at','platforms','rotation_weight','eyebrow_text','headline','body_text','cta_text','click_url','disclaimer_text','media_type','image_url','video_url','video_poster_image_url','video_muted_by_default']
};
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function notice(text, error = false) {
  clearTimeout(timer); $('notice').textContent = text; $('notice').hidden = false;
  $('notice').setAttribute('role', error ? 'alert' : 'status');
  timer = setTimeout(() => { $('notice').hidden = true; }, 5000);
}
function authControls(busy) {
  authBusy = busy;
  for (const id of ['google','email','email-submit','email-retry']) $(id).disabled = !ready || busy;
}
function clearLibrary() {
  catalog = null; selected = null;
  $('library').hidden = true; $('loading').hidden = true; $('auth-panel').hidden = false;
  $('records').replaceChildren(); $('details').replaceChildren(); $('fetched').textContent = '';
  $('sponsor-filter').replaceChildren(new Option('All sponsors','all'));
  $('campaign-filter').replaceChildren(new Option('All campaigns','all'));
}
function safeUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}
function validateLibrary(data) {
  if (!data || data.environment !== 'test' || !Number.isFinite(Date.parse(data.fetched_at))) throw Error('Invalid library');
  for (const type of Object.keys(fields)) {
    if (!Array.isArray(data[type]) || data[type].length > 500) throw Error('Invalid library');
    const seen = new Set();
    for (const row of data[type]) {
      if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 200 || row.id.includes('/') || seen.has(row.id)) throw Error('Invalid record');
      seen.add(row.id);
      for (const key of fields[type]) {
        const value = row[key];
        if (value == null) continue;
        if (key.endsWith('_url') && (typeof value !== 'string' || !safeUrl(value))) throw Error('Invalid link');
        if (['enabled','approved','exclusive','video_muted_by_default'].includes(key)) {
          if (typeof value !== 'boolean') throw Error('Invalid flag');
        } else if (key === 'rotation_weight') {
          if (!Number.isSafeInteger(value) || value < 0) throw Error('Invalid weight');
        } else if (key === 'platforms') {
          if (!Array.isArray(value) || value.length > 2 || value.some(p => !['ios','android'].includes(p))) throw Error('Invalid platform');
        } else if (['share_schedule','creative_overrides'].includes(key)) {
          if (!Array.isArray(value) || value.length > 200 || value.some(v => !v || typeof v !== 'object' || Array.isArray(v))) throw Error('Invalid schedule');
        } else if (typeof value !== 'string' || value.length > 4000) throw Error('Invalid text');
      }
    }
  }
  return data;
}
function name(type, id) { return catalog[type].find(row => row.id === id)?.name || id || 'Not set'; }
function display(key, value) {
  if (value == null) return 'Not set';
  if (['start_at','end_at'].includes(key)) {
    const when = new Date(value);
    return Number.isFinite(when.getTime()) ? when.toISOString() + '\nLocal: ' + when.toLocaleString() : 'Invalid stored date';
  }
  if (key === 'sponsor_id') return name('sponsors', value) + '\nID: ' + value;
  if (key === 'campaign_id') return name('campaigns', value) + '\nID: ' + value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (key === 'platforms') return value.map(p => p === 'ios' ? 'iOS' : 'Android').join(', ') || 'None';
  if (key === 'exam' || key === 'module') return value || 'Not set';
  return String(value);
}
function detail(row) {
  $('details').replaceChildren(node('h2', row.name || row.id));
  const list = node('dl');
  list.append(node('dt','Record ID'), node('dd',row.id));
  for (const key of fields[section]) {
    const value = row[key];
    list.append(node('dt', labels[key]));
    const item = node('dd');
    if (key.endsWith('_url') && value && safeUrl(value)) {
      const link = node('a',value); link.href = value; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link);
    } else if (['share_schedule','creative_overrides'].includes(key)) {
      if (!value?.length) item.textContent = value == null ? 'Not set' : 'None';
      for (const entry of value || []) {
        const box = node('div',undefined,'nested');
        if (key === 'share_schedule') {
          box.append(node('p','Share: ' + (entry.percent ?? 'Not set') + '%'),
            node('p','Starts: ' + display('start_at',entry.start_at)),node('p','Ends: ' + display('end_at',entry.end_at)));
        } else {
          box.append(node('p','Placement: ' + (entry.placement ?? 'Not set')),
            node('p','Exam: ' + (entry.exam ?? 'All exams')),node('p','Module: ' + (entry.module ?? 'All modules')),
            node('p','Allowed creatives: ' + (entry.creative_ids || []).map(id => name('creatives',id)).join(', ')));
        }
        item.append(box);
      }
    } else item.textContent = display(key,value);
    list.append(item);
  }
  $('details').append(list);
  if (section === 'sponsors' || section === 'campaigns') {
    const related = node('div',undefined,'related');
    const button = node('button',section === 'sponsors' ? 'View campaigns' : 'View creatives');
    button.onclick = () => {
      if (section === 'sponsors') { $('sponsor-filter').value = row.id; updateCampaigns(); section = 'campaigns'; }
      else { $('campaign-filter').value = row.id; section = 'creatives'; }
      selected = null; render();
    };
    related.append(button); $('details').append(related);
  }
  if (section === 'creatives') $('details').append(node('p','Weights control creative rotation within the selected campaign, not the campaign’s exposure share.','muted'));
}
function updateCampaigns() {
  $('campaign-filter').replaceChildren(new Option('All campaigns','all'));
  for (const row of catalog.campaigns.filter(row => $('sponsor-filter').value === 'all' || row.sponsor_id === $('sponsor-filter').value)) {
    $('campaign-filter').append(new Option(row.name || row.id,row.id));
  }
}
function render() {
  if (!catalog || !user) return;
  const sponsor = $('sponsor-filter').value, campaign = $('campaign-filter').value;
  const campaignIds = new Set(catalog.campaigns.filter(row =>
    (sponsor === 'all' || row.sponsor_id === sponsor) && (campaign === 'all' || row.id === campaign)).map(row => row.id));
  const rows = catalog[section].filter(row => section === 'sponsors' ? sponsor === 'all' || row.id === sponsor :
    section === 'campaigns' ? campaignIds.has(row.id) : campaignIds.has(row.campaign_id));
  for (const type of Object.keys(fields)) $('tab-' + type).setAttribute('aria-pressed',String(section === type));
  $('campaign-filter').disabled = section === 'sponsors';
  $('summary').textContent = rows.length + ' ' + section + ' · ' + catalog.sponsors.length + ' sponsors, ' + catalog.campaigns.length + ' campaigns, ' + catalog.creatives.length + ' creatives in this test catalog';
  $('records').replaceChildren();
  if (!rows.length) $('records').append(node('p','No records match these filters.','empty'));
  for (const row of rows) {
    const button = node('button',row.name || row.id,'record');
    const parent = section === 'campaigns' ? name('sponsors',row.sponsor_id) : section === 'creatives' ? name('campaigns',row.campaign_id) : row.id;
    button.append(node('small',parent),node('small','Enabled: ' + display('enabled',row.enabled) + (section === 'sponsors' ? '' : ' · Approved: ' + display('approved',row.approved))));
    button.setAttribute('aria-pressed',String(selected === row.id));
    button.onclick = () => { selected = row.id; render(); };
    $('records').append(button);
  }
  const row = rows.find(row => row.id === selected);
  if (row) detail(row); else $('details').replaceChildren(node('p','Select a record to inspect its configuration.','empty'));
}
async function load() {
  if (!user) return;
  const run = ++generation, uid = user.uid;
  clearLibrary(); $('auth-panel').hidden = true; $('loading').hidden = false; $('refresh').disabled = true;
  clearTimeout(timer); $('notice').hidden = true;
  try {
    if (config.environment !== 'test' || config.firebase.projectId !== 'medical-test-prep-ads-test') throw Error('Wrong project');
    appCheck ||= initializeAppCheck(app,{provider:new ReCaptchaEnterpriseProvider(config.siteKey),isTokenAutoRefreshEnabled:true});
    const response = await fetchLibrary({});
    if (run !== generation || user?.uid !== uid) return;
    catalog = validateLibrary(response.data);
    for (const row of catalog.sponsors) $('sponsor-filter').append(new Option(row.name || row.id,row.id));
    updateCampaigns(); render();
    $('library').hidden = false; $('loading').hidden = true;
    $('fetched').textContent = 'Fetched ' + new Date(catalog.fetched_at).toLocaleString() + ' (local time). Stored schedule times are shown in UTC and local time.';
  } catch (error) {
    if (run !== generation || user?.uid !== uid) return;
    clearLibrary();
    notice(error?.code?.includes('permission-denied') ? 'This account does not have admin or ads-team library access.' :
      'The campaign library could not load. Check your connection or contact your administrator.',true);
  } finally { if (run === generation) $('refresh').disabled = false; }
}
function resetLink() {
  emailLink = ''; window.history.replaceState(null,'',window.location.pathname);
  $('email-submit').textContent = 'Email me a sign-in link'; $('email-retry').hidden = true;
  $('email-help').textContent = 'We will email you a sign-in link. No password is needed.';
}
function handleUser(value) {
  ++generation; user = value; clearLibrary(); $('sign-out').hidden = !user;
  $('account').textContent = user?.email ? 'Signed in: ' + user.email : 'Admin and ads-team access only';
  if (emailLink) {
    $('email-submit').textContent = 'Confirm email and sign in'; $('email-retry').hidden = false;
    $('email-help').textContent = 'Enter the email address that received this link to finish signing in.';
  } else if (user) load();
}
$('google').onclick = async () => {
  if (!ready || authBusy) return;
  authControls(true); if (emailLink) resetLink();
  const provider = new GoogleAuthProvider(); provider.setCustomParameters({prompt:'select_account'});
  try { await signInWithPopup(auth,provider); }
  catch { notice('Google sign-in could not finish. Allow pop-ups and try again.',true); }
  finally { authControls(false); }
};
$('email-form').onsubmit = async event => {
  event.preventDefault(); if (!ready || authBusy) return;
  const email = $('email').value.trim();
  if (!email || !$('email').checkValidity()) { $('email').reportValidity(); return; }
  authControls(true);
  try {
    if (emailLink) {
      const result = await signInWithEmailLink(auth,email,emailLink);
      resetLink(); $('email').value = ''; handleUser(result.user);
    } else {
      await sendSignInLinkToEmail(auth,email,{url:'https://matthewobell.github.io/medical-test-prep-reporting/admin-library.html',handleCodeInApp:true});
      notice('Sign-in link sent. Check your inbox and spam folder. Only approved admin and ads-team accounts can access this library.');
    }
  } catch { notice('Email sign-in could not finish. Confirm the recipient email, check your connection, or request a new link.',true); }
  finally { authControls(false); }
};
$('email-retry').onclick = resetLink;
$('sign-out').onclick = async () => {
  ++generation; clearLibrary(); resetLink(); $('email').value = '';
  try { await signOut(auth); } catch { notice('Sign-out could not finish. Close this tab to end this session.',true); }
};
$('refresh').onclick = load;
$('sponsor-filter').onchange = () => { if (!catalog) return; selected = null; updateCampaigns(); render(); };
$('campaign-filter').onchange = () => { selected = null; render(); };
for (const type of Object.keys(fields)) $('tab-' + type).onclick = () => { section = type; selected = null; render(); };
try {
  await setPersistence(auth,browserSessionPersistence);
  onAuthStateChanged(auth,handleUser); ready = true; authControls(false);
} catch { clearLibrary(); notice('A secure sign-in session could not start. Check browser storage settings and reload.',true); }
