import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, setPersistence, browserSessionPersistence, onAuthStateChanged, GoogleAuthProvider,
  signInWithPopup, signOut, sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider, getToken } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { reportingConfig as config } from './reporting-config.js';

const $ = id => document.getElementById(id);
const app = initializeApp(config.firebase, 'staff-reporting');
const auth = getAuth(app);
const fetchLibrary = httpsCallable(getFunctions(app, config.region), 'get_admin_library');
let user = null, catalog = null, generation = 0, appCheck, timer, ready = false, authBusy = false;
const fetchDrafts = httpsCallable(getFunctions(app, config.region), 'get_ad_drafts');
const persistDraft = httpsCallable(getFunctions(app, config.region), 'save_ad_draft');
const fetchReview = httpsCallable(getFunctions(app, config.region), 'review_ad_draft');
const prepareCampaignPublish = httpsCallable(getFunctions(app, config.region), 'prepare_campaign_publish');
const publishCampaignDraft = httpsCallable(getFunctions(app, config.region), 'publish_campaign_draft');
const requestCampaignPause = httpsCallable(getFunctions(app, config.region), 'pause_campaign');
let campaignPauseBusy = false, pauseRequest = 0;
let reviewRequest = 0;
const prepareUpload = httpsCallable(getFunctions(app, config.region), 'prepare_ad_upload');
const completeUpload = httpsCallable(getFunctions(app, config.region), 'complete_ad_upload');
let uploadTask = null, previewUrl = null;
let drafts = [], editor = null, editorRead = null, dirty = false, draftBusy = false, draftRequest = 0;
let section = 'campaigns', selected = null;
let remembered = {}, detailTab = 'Overview';
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
  campaignPauseBusy = false; ++pauseRequest;
  invalidateReview();
  clearMediaPreview();
  catalog = null; selected = null; drafts = []; editor = null; editorRead = null; dirty = false; draftBusy = false; ++draftRequest;
  $('review-draft').disabled = false;
  $('editor-fields').replaceChildren(); $('draft-editor').hidden = true; $('browse-panel').hidden = false; $('draft-status').textContent = '';
  $('library').hidden = true; $('loading').hidden = true; $('auth-panel').hidden = false;
  $('records').replaceChildren(); $('details').replaceChildren(); $('fetched').textContent = '';
  $('sponsor-filter').replaceChildren(new Option('All sponsors','all'));
  $('workspace-navigation').hidden = true;
  for (const id of ['campaign-count','creative-count','draft-count']) $(id).textContent = '0';
  $('record-head').replaceChildren();
  $('library-filters').hidden = true; $('library-search').value = ''; $('record-status').value = 'all'; remembered = {}; section = 'campaigns'; detailTab = 'Overview';
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
function localTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Invalid stored date';
  return date.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'}) + ' at ' +
    date.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZoneName:'short'}).replace(/\s+([AP]M)/,'$1');
}
function selectionKey() { return 'campaign-library-selection-v1:' + user.uid; }
function restoreSelection() {
  remembered = {}; section = 'campaigns'; selected = null;
  try {
    const saved = JSON.parse(window.localStorage.getItem(selectionKey()));
    if (saved && ['sponsors','campaigns','creatives','drafts'].includes(saved.section)) {
      section = saved.section;
      for (const type of ['sponsors','campaigns','creatives','drafts']) {
        const id = saved.records?.[type];
        if (typeof id === 'string' && id.length <= 200 && !id.includes('/')) remembered[type] = id;
      }
    }
  } catch { /* Browsing still works when storage is unavailable. */ }
}
function rememberSelection() {
  if (!user || !catalog) return;
  try { window.localStorage.setItem(selectionKey(),JSON.stringify({section,records:remembered})); } catch {}
}
function chooseRow(rows) {
  const row = rows.find(row => row.id === selected) || rows.find(row => row.id === remembered[section]) || rows[0];
  selected = row?.id || null;
  if (row && !$('library-search').value.trim()) remembered[section] = row.id;
  rememberSelection(); return row;
}
function matchesSearch(row) {
  const query = $('library-search').value.trim().toLocaleLowerCase();
  let campaign, sponsor;
  if (section === 'creatives') campaign = catalog.campaigns.find(item => item.id === row.campaign_id);
  else if (section === 'campaigns') campaign = row;
  if (campaign) sponsor = catalog.sponsors.find(item => item.id === campaign.sponsor_id);
  return [row.id,row.name,row.target_id,row.kind,campaign?.id,campaign?.name,sponsor?.id,sponsor?.name]
    .filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
}
function selectRecord(id) {
  selected = id; remembered[section] = id; detailTab = 'Overview'; rememberSelection(); render();
}
function detailField(list,title,value,wide = false) {
  const field = node('div',undefined,'detail-field' + (wide ? ' wide' : ''));
  field.append(node('dt',title),node('dd',value)); list.append(field); return field;
}
function display(key, value) {
  if (value == null) return 'Not set';
  if (['start_at','end_at'].includes(key)) {
    const when = new Date(value);
    return Number.isFinite(when.getTime()) ? localTime(value) : 'Invalid stored date';
  }
  if (key === 'sponsor_id') return name('sponsors', value) + '\nID: ' + value;
  if (key === 'campaign_id') return name('campaigns', value) + '\nID: ' + value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (key === 'platforms') return value.map(p => p === 'ios' ? 'iOS' : 'Android').join(', ') || 'None';
  if (key === 'exam' || key === 'module') return value || 'Not set';
  return String(value);
}
function detail(row) {
  $('details').replaceChildren(node('h2', row.name || row.id,'workspace-title'));
  const groups = section === 'campaigns' ? [
    ['Overview',['name','sponsor_id','approved','enabled']],
    ['Schedule',['start_at','end_at','share_schedule']],
    ['Targeting',['platforms','placement','exam','module','exclusive','creative_overrides']]
  ] : section === 'creatives' ? [
    ['Overview',['name','campaign_id','approved','enabled','rotation_weight']],
    ['Schedule',['start_at','end_at']],['Targeting',['platforms']],
    ['Content',['eyebrow_text','headline','body_text','cta_text','click_url','disclaimer_text']],
    ['Media',['media_type','image_url','video_url','video_poster_image_url','video_muted_by_default']]
  ] : [['Overview',fields[section]]];
  if (!groups.some(([title]) => title === detailTab)) detailTab = 'Overview';
  const panes = [], buttons = [], nav = node('nav',undefined,'detail-tabs');
  nav.setAttribute('aria-label','Record detail sections');
  if (groups.length > 1) $('details').append(nav);
  for (const [index,[title,keys]] of groups.entries()) {
  const list = node('dl',undefined,'detail-pane'); list.hidden = title !== detailTab;
  const button = node('button',title); button.type = 'button';
  button.setAttribute('aria-pressed',String(title === detailTab));
  button.onclick = () => { detailTab = title; panes.forEach((pane,i) => pane.hidden = i !== index); buttons.forEach((tab,i) => tab.setAttribute('aria-pressed',String(i === index))); };
  panes.push(list); buttons.push(button); nav.append(button);
  if (index === 0) detailField(list,'Record ID',row.id);
  for (const key of keys) {
    const value = row[key];
    const field = node('div',undefined,'detail-field' + (['share_schedule','creative_overrides'].includes(key) ? ' wide' : ''));
    field.append(node('dt',labels[key]));
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
    field.append(item); list.append(field);
  }
  $('details').append(list);
  }
  if (section === 'campaigns' || section === 'creatives') {
    const edit = node('button','Edit as draft'); edit.className = 'related';
    edit.onclick = () => openEditor({kind:section === 'campaigns' ? 'campaign' : 'creative', target_id:row.id,
      fields:Object.fromEntries(fields[section].filter(key => !['approved','enabled'].includes(key)).map(key => [key,row[key]]))});
    $('details').append(edit);
  }
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
  if (section === 'campaigns' && row.enabled === true) {
    const pause = node('button','Pause campaign','related'); pause.type = 'button';
    pause.onclick = () => pauseCampaign(row,pause); $('details').append(pause);
  }
  if (section === 'creatives') $('details').append(node('p','Weights control creative rotation within the selected campaign, not the campaignâ€™s exposure share.','muted'));
}
async function pauseCampaign(row,button) {
  if (!user || !catalog || editor || campaignPauseBusy || row.enabled !== true) return;
  const run = generation, uid = user.uid, currentCatalog = catalog, ticket = ++pauseRequest;
  const active = () => generation === run && user?.uid === uid && catalog === currentCatalog &&
    ticket === pauseRequest && !editor;
  campaignPauseBusy = true; button.disabled = true;
  let sent = false;
  try {
    const summary = (await requestCampaignPause({action:'prepare',target_id:row.id})).data;
    if (!active() || section !== 'campaigns' || selected !== row.id) return;
    if (summary?.environment !== 'test' || summary.target_id !== row.id || summary.enabled !== true ||
        typeof summary.name !== 'string' || !summary.name || summary.name.length > 200 ||
        !/^[0-9a-f]{64}$/.test(summary.confirmation || '')) throw Error('Invalid pause summary');
    if (!window.confirm('Pause â€œ' + summary.name + 'â€?\n\nThis stops new ad selections for this campaign. Ads already displayed may finish. Approval, dates, targeting, and exposure share stay unchanged.')) return;
    if (!active()) return;
    sent = true;
    const receipt = (await requestCampaignPause({action:'pause',target_id:row.id,confirmation:summary.confirmation})).data;
    if (!active()) return;
    if (receipt?.environment !== 'test' || receipt.target_id !== row.id || receipt.paused !== true || receipt.enabled !== false ||
        !/^[0-9a-f]{64}$/.test(receipt.history_id || '') || !Number.isFinite(Date.parse(receipt.paused_at))) throw Error('Invalid pause receipt');
    await load();
    if (user?.uid === uid) notice('Campaign paused in the test project. New ad selections for it are stopped.');
  } catch (error) {
    if (!active()) return;
    if (error?.code?.includes('permission-denied') || error?.code?.includes('unauthenticated')) {
      clearLibrary(); notice('Staff pause access could not be confirmed. Sign in with an approved account.',true); return;
    }
    notice(error?.code?.includes('aborted') ? 'The campaign changed. Refresh the library and confirm its pause again.' :
      error?.code?.includes('failed-precondition') ? 'This campaign is already disabled or its state needs review. Refresh the library.' :
      sent ? 'Pause could not be confirmed. Refresh the library to check Enabled before trying again; the request may have completed.' :
      'A pause confirmation could not be prepared. Refresh the library and try again.',true);
  } finally {
    button.disabled = false;
    if (pauseRequest === ticket) campaignPauseBusy = false;
  }
}
function updateCampaigns() {
  $('campaign-filter').replaceChildren(new Option('All campaigns','all'));
  for (const row of catalog.campaigns.filter(row => $('sponsor-filter').value === 'all' || row.sponsor_id === $('sponsor-filter').value)) {
    $('campaign-filter').append(new Option(row.name || row.id,row.id));
  }
}
function matchesStatus(row) {
  const status = $('record-status').value;
  return status === 'all' || status === 'approved' && row.approved === true || status === 'unapproved' && row.approved === false || status === 'enabled' && row.enabled === true || status === 'disabled' && row.enabled === false;
}
function renderTable(rows) {
  const columns = section === 'campaigns' ? ['Campaign','Approval','Enabled','Platforms','Exposure share','Ad creatives'] :
    section === 'creatives' ? ['Ad creative','Approval','Enabled','Platforms','Rotation weight'] :
    section === 'sponsors' ? ['Sponsor','Enabled','Campaigns'] : ['Draft','Type','Saved','Revision'];
  const header = node('tr'); for (const title of columns) header.append(node('th',title));
  $('record-head').replaceChildren(header); $('records').replaceChildren();
  if (!rows.length) { const tr = node('tr'), td = node('td','No records match these filters.','empty'); td.colSpan = columns.length; tr.append(td); $('records').append(tr); return; }
  for (const row of rows) {
    const tr = node('tr',undefined,row.id === selected ? 'selected' : '');
    const td = node('td'), button = node('button',row.name || row.id,'name-button');
    button.setAttribute('aria-pressed',String(row.id === selected)); button.onclick = () => selectRecord(row.id); td.append(button);
    const parent = section === 'campaigns' ? name('sponsors',row.sponsor_id) : section === 'creatives' ? name('campaigns',row.campaign_id) : row.id;
    td.append(node('small',parent)); tr.append(td);
    const approval = value => { const cell = node('td'); cell.append(node('span',value === true ? 'Approved' : value === false ? 'Not approved' : 'Not set',value === true ? 'badge' : 'badge draft')); return cell; };
    const enabled = value => node('td',value === true ? 'Yes' : value === false ? 'No' : 'Not set');
    if (section === 'campaigns') {
      const shares = [...new Set((row.share_schedule || []).map(entry => entry.percent == null ? 'Not set' : entry.percent + '%'))].join(', ') || 'Not set';
      tr.append(approval(row.approved),enabled(row.enabled),node('td',display('platforms',row.platforms)),node('td',shares),node('td',String(catalog.creatives.filter(item => item.campaign_id === row.id).length)));
    } else if (section === 'creatives') tr.append(approval(row.approved),enabled(row.enabled),node('td',display('platforms',row.platforms)),node('td',display('rotation_weight',row.rotation_weight)));
    else if (section === 'sponsors') tr.append(enabled(row.enabled),node('td',String(catalog.campaigns.filter(item => item.sponsor_id === row.id).length)));
    else tr.append(node('td',row.kind === 'creative' ? 'Creative draft' : 'Campaign draft'),node('td',localTime(row.updated_at)),node('td',String(row.revision)));
    tr.onclick = event => { if (!event || event.target !== button) selectRecord(row.id); };
    $('records').append(tr);
  }
}
function render() {
  if (!catalog || !user) return;
  const titles = {campaigns:'Campaigns',creatives:'Ad creatives',sponsors:'Sponsors',drafts:'Drafts'};
  $('browse-title').textContent = titles[section];
  $('browse-description').textContent = section === 'drafts' ? 'Continue saved work without changing ad delivery.' : section === 'campaigns' ? 'Manage campaigns and the ads within them.' : section === 'creatives' ? 'Manage the ads within your campaigns.' : 'Inspect sponsor records and their campaigns.';
  $('library-search').placeholder = 'Search ' + titles[section].toLowerCase() + ' by name or ID';
  $('campaign-count').textContent = String(catalog.campaigns.length);
  $('creative-count').textContent = String(catalog.creatives.length);
  $('draft-count').textContent = String(drafts.length);
  $('record-status').disabled = section === 'drafts';
  $('tab-drafts').setAttribute('aria-pressed',String(section === 'drafts'));
  $('sponsor-filter').disabled = section === 'drafts';
  if (section === 'drafts') { renderDrafts(); return; }
  const sponsor = $('sponsor-filter').value, campaign = $('campaign-filter').value;
  const campaignIds = new Set(catalog.campaigns.filter(row =>
    (sponsor === 'all' || row.sponsor_id === sponsor) && (campaign === 'all' || row.id === campaign)).map(row => row.id));
  const rows = catalog[section].filter(row => section === 'sponsors' ? sponsor === 'all' || row.id === sponsor :
    section === 'campaigns' ? campaignIds.has(row.id) : campaignIds.has(row.campaign_id)).filter(matchesSearch).filter(matchesStatus);
  const currentRow = chooseRow(rows);
  for (const type of Object.keys(fields)) $('tab-' + type).setAttribute('aria-pressed',String(section === type));
  $('campaign-filter').disabled = section === 'sponsors';
  $('summary').textContent = rows.length + ' ' + section + ' Â· ' + catalog.sponsors.length + ' sponsors, ' + catalog.campaigns.length + ' campaigns, ' + catalog.creatives.length + ' creatives in this test catalog';
  renderTable(rows);
  if (currentRow) detail(currentRow); else $('details').replaceChildren(node('p','No records match these filters.','empty'));
}
async function load() {
  if (!user) return;
  const run = ++generation, uid = user.uid;
  clearLibrary(); $('auth-panel').hidden = true; $('loading').hidden = false; $('refresh').disabled = true;
  clearTimeout(timer); $('notice').hidden = true;
  try {
    if (config.environment !== 'test' || config.firebase.projectId !== 'medical-test-prep-ads-test') throw Error('Wrong project');
    appCheck ||= initializeAppCheck(app,{provider:new ReCaptchaEnterpriseProvider(config.siteKey),isTokenAutoRefreshEnabled:true});
    const [response, draftResponse] = await Promise.all([fetchLibrary({}), fetchDrafts({draft_id:null})]);
    if (run !== generation || user?.uid !== uid) return;
    catalog = validateLibrary(response.data); drafts = validateDraftList(draftResponse.data);
    for (const row of catalog.sponsors) $('sponsor-filter').append(new Option(row.name || row.id,row.id));
    restoreSelection(); updateCampaigns(); render();
    $('library-filters').hidden = false; $('workspace-navigation').hidden = false;
    $('library').hidden = false; $('loading').hidden = true;
    $('fetched').textContent = 'Fetched ' + localTime(catalog.fetched_at) + ' (local time). Schedule times use your browserâ€™s local time zone.';
  } catch (error) {
    if (run !== generation || user?.uid !== uid) return;
    clearLibrary();
    notice(error?.code?.includes('permission-denied') ? 'This account does not have admin or ads-team library access.' :
      'The campaign library could not load. Check your connection or contact your administrator.',true);
  } finally { if (run === generation) $('refresh').disabled = false; }
}
function validDraft(value, full = false) {
  if (!value || value.environment !== 'test' || value.status !== 'draft' || !['campaign','creative'].includes(value.kind) ||
      typeof value.id !== 'string' || !value.id || value.id.includes('/') || value.id.length > 200 ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      (value.target_id !== null && (typeof value.target_id !== 'string' || !value.target_id || value.target_id.includes('/'))) ||
      typeof value.name !== 'string' || typeof value.updated_by !== 'string' ||
      !Number.isFinite(Date.parse(value.updated_at))) throw Error('Invalid draft response');
  if (full) {
    if (!value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)) throw Error('Invalid draft fields');
    const type = value.kind === 'campaign' ? 'campaigns' : 'creatives';
    if (Object.keys(value.fields).some(key => (!fields[type].includes(key) && !(type === 'creatives' && key === 'media_assets')) || ['approved','enabled'].includes(key))) throw Error('Invalid draft fields');
    const assets = value.fields.media_assets;
    if (assets !== undefined && (!assets || typeof assets !== 'object' || Array.isArray(assets) || Object.keys(assets).some(key => !['image','video','poster'].includes(key)) || Object.values(assets).some(id => typeof id !== 'string' || !id || id.length > 200 || id.includes('/')))) throw Error('Invalid media references');
    // Reuse the library field checks before putting any stored values into controls.
    validateLibrary({environment:'test',fetched_at:value.updated_at,sponsors:[],campaigns:[],creatives:[],
      [type]:[{id:value.id,...value.fields}]});
  }
  return value;
}
function validateDraftList(data) {
  if (data?.environment !== 'test' || !Array.isArray(data.drafts) || data.drafts.length > 500) throw Error('Invalid draft list');
  const ids = new Set();
  for (const draft of data.drafts) { validDraft(draft); if (ids.has(draft.id)) throw Error('Duplicate draft'); ids.add(draft.id); }
  return data.drafts;
}
function draftMetadata(draft) {
  return draft.id ? 'Saved ' + localTime(draft.updated_at) + ' Â· Staff ID: ' + draft.updated_by + ' Â· Revision ' + draft.revision + ' Â· Draft ID: ' + draft.id : 'Not saved yet';
}
function renderDrafts() {
  for (const type of Object.keys(fields)) $('tab-' + type).setAttribute('aria-pressed','false');
  $('campaign-filter').disabled = true;
  const rows = drafts.filter(matchesSearch), currentDraft = chooseRow(rows);
  $('summary').textContent = rows.length + ' drafts Â· Drafts are shown separately from catalog filters and do not serve ads.';
  renderTable(rows); $('details').replaceChildren();
  const draft = currentDraft;
  if (!draft) { $('details').append(node('p','No drafts match this search.','empty')); return; }
  $('details').append(node('h2',draft.name));
  const metadata = node('dl');
  for (const [title,value] of [['Saved',localTime(draft.updated_at)],['Revision',String(draft.revision)],
    ['Staff ID',draft.updated_by],['Draft ID',draft.id],['Status',draft.target_id ? 'Draft of existing record: ' + draft.target_id : 'Draft for a new record']]) {
    detailField(metadata,title,value);
  }
  $('details').append(metadata);
  const button = node('button','Open draft','related');
  button.onclick = () => readDraft(draft.id, button);
  $('details').append(button);
}
async function readDraft(id, button) {
  const run = generation, uid = user?.uid, ticket = ++draftRequest;
  if (!uid) return;
  const wasEditing = !!editor;
  if (wasEditing) { draftBusy = true; $('draft-fields').disabled = true; $('save-draft').disabled = true; $('close-draft').disabled = true; }
  if (button) button.disabled = true;
  try {
    const response = await fetchDrafts({draft_id:id});
    if (run !== generation || user?.uid !== uid || ticket !== draftRequest) return;
    if (response.data?.environment !== 'test') throw Error('Invalid draft response');
    const draft = validDraft(response.data.draft,true);
    if (draft.id !== id) throw Error('Unexpected draft');
    openEditor(draft);
  } catch (error) {
    if (run !== generation || user?.uid !== uid || ticket !== draftRequest) return;
    if (error?.code?.includes('permission-denied') || error?.code?.includes('unauthenticated')) {
      clearLibrary(); notice('Staff access could not be confirmed. Sign in with an approved account.',true);
    } else notice('The draft could not load. Refresh the library and try again.',true);
  } finally {
    if (button) button.disabled = false;
    if (run === generation && user?.uid === uid && wasEditing && editor) {
      draftBusy = false; $('draft-fields').disabled = false; $('save-draft').disabled = false; $('close-draft').disabled = false;
    }
  }
}
function localDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw Error('Invalid draft date');
  const pad = (n, length = 2) => String(n).padStart(length,'0');
  return date.getFullYear() + '-' + pad(date.getMonth()+1) + '-' + pad(date.getDate()) + 'T' +
    pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) + '.' + pad(date.getMilliseconds(),3);
}
let controlNumber = 0;
function editField(parent, key, value, choices = null) {
  const box = node('div',undefined,'editor-field field-' + key), id = 'draft-control-' + (++controlNumber);
  const label = node('label',labels[key] || ({percent:'Exposure share (%)',creative_ids:'Allowed creatives'})[key] || key);
  label.htmlFor = id; box.append(label);
  let control, read;
  if (key === 'platforms' || key === 'creative_ids') {
    control = node('div',undefined,'choices'); control.id = id; control.setAttribute('role','group');
    label.id = id + '-label'; control.setAttribute('aria-labelledby',label.id); label.removeAttribute('for');
    const options = key === 'platforms' ? [['ios','iOS'],['android','Android']] :
      catalog.creatives.map(row => [row.id,row.name || row.id]);
    for (const existing of value || []) if (!options.some(([option]) => option === existing)) options.push([existing,existing + ' (not in current catalog)']);
    const inputs = options.map(([option,text]) => {
      const input = node('input'); input.type = 'checkbox'; input.value = option; input.checked = (value || []).includes(option);
      const wrap = node('label'); wrap.append(input,document.createTextNode(text)); control.append(wrap); return input;
    });
    read = () => inputs.filter(input => input.checked).map(input => input.value);
  } else if (choices || ['exclusive','video_muted_by_default','media_type'].includes(key)) {
    control = node('select'); control.append(new Option('Not set',''));
    const options = choices || (key === 'media_type' ? [['image','Image'],['video','Video']] : [['true','Yes'],['false','No']]);
    for (const [option,text] of options) control.append(new Option(text,option));
    if (value != null && !Array.from(control.options).some(option => option.value === String(value))) control.append(new Option(String(value) + ' (not in current catalog)',String(value)));
    control.value = value == null ? '' : String(value);
    read = () => control.value === '' ? null : ['exclusive','video_muted_by_default'].includes(key) ? control.value === 'true' : control.value;
  } else {
    control = node(['body_text','disclaimer_text'].includes(key) ? 'textarea' : 'input');
    if (['start_at','end_at'].includes(key)) {
      control.type = 'datetime-local'; control.step = '0.001'; control.value = localDate(value);
      const original = control.value;
      read = () => !control.value ? null : control.value === original && value ? value : new Date(control.value).toISOString();
    } else if (['rotation_weight','percent'].includes(key)) {
      control.type = 'number'; control.min = key === 'percent' ? '0' : '1'; control.max = key === 'percent' ? '100' : String(Number.MAX_SAFE_INTEGER); control.step = '1'; control.value = value ?? '';
      read = () => control.value === '' ? null : Number(control.value);
    } else {
      if (key.endsWith('_url')) control.type = 'url';
      control.maxLength = key.endsWith('_url') ? 2048 : key === 'name' || ['exam','module','placement'].includes(key) ? 200 : 4000;
      control.value = value ?? ''; read = () => control.value === '' ? null : control.value;
    }
  }
  if (!control.id) control.id = id;
  box.append(control); parent.append(box);
  return read;
}
function editList(parent, key, values) {
  const box = node('fieldset',undefined,'wide'); box.append(node('legend',labels[key]));
  box.append(node('p',key === 'share_schedule' ? 'Shares describe this campaignâ€™s intended exposure over each period. Full booking and overlap checks happen before publishing.' :
    'Choose existing creatives for a placement, exam, or module. Leave unfinished settings blank to complete later.','field-help'));
  const list = node('div',undefined,'draft-list'), rows = [], maximum = key === 'share_schedule' ? 100 : 200;
  const add = node('button',key === 'share_schedule' ? 'Add share period' : 'Add creative override','secondary'); add.type = 'button';
  function append(value = {}) {
    if (rows.length >= maximum) return;
    const entry = node('fieldset',undefined,'draft-entry'); entry.append(node('legend',key === 'share_schedule' ? 'Share period' : 'Creative override'));
    const keys = key === 'share_schedule' ? ['start_at','end_at','percent'] : ['placement','exam','module','creative_ids'];
    const readers = keys.map(field => [field,editField(entry,field,value[field])]);
    const row = {entry,read:() => Object.fromEntries(readers.map(([field,read]) => [field,read()]))};
    const remove = node('button','Remove from draft','secondary'); remove.type = 'button';
    remove.onclick = () => { rows.splice(rows.indexOf(row),1); entry.remove(); add.disabled = false; dirty = true; invalidateReview(); };
    entry.append(remove); list.append(entry); rows.push(row); add.disabled = rows.length >= maximum;
  }
  for (const value of values || []) append(value);
  add.onclick = () => { append(); dirty = true; invalidateReview(); };
  box.append(list,add); parent.append(box);
  return () => rows.map(row => row.read());
}
function openEditor(draft) {
  if (!catalog || !user) return;
  clearMediaPreview(); invalidateReview();
  if (draft.id) { section = 'drafts'; selected = draft.id; remembered.drafts = draft.id; rememberSelection(); }
  ++draftRequest; editor = structuredClone(draft); dirty = false; draftBusy = false;
  if (editor.kind === 'creative') editor.fields.media_assets ||= {};
  $('draft-fields').disabled = false; $('save-draft').disabled = false; $('close-draft').disabled = false; $('review-draft').disabled = false;
  $('draft-editor').hidden = false; $('browse-panel').hidden = true; $('reload-draft').hidden = true;
  $('draft-status').textContent = '';
  $('editor-title').textContent = (draft.kind === 'campaign' ? 'Campaign' : 'Creative') + ' draft';
  $('draft-metadata').textContent = draftMetadata(draft) + (draft.target_id ? ' Â· Based on record: ' + draft.target_id : ' Â· New record');
  $('editor-fields').replaceChildren();
  const type = draft.kind === 'campaign' ? 'campaigns' : 'creatives', readers = [];
  const root = $('editor-fields');
  const details = node('section',undefined,'form-section wide');
  details.append(node('h3','Details','section-heading'));
  const grid = node('div',undefined,'field-grid ' + draft.kind + '-grid'); details.append(grid); root.append(details);
  const parents = {};
  if (draft.kind === 'campaign') {
    const targeting = node('section',undefined,'form-section wide'); targeting.append(node('h3','Targeting','section-heading'));
    const targetGrid = node('div',undefined,'field-grid targeting-grid'); targeting.append(targetGrid); root.append(targeting);
    for (const key of ['platforms','placement','exam','module','exclusive']) parents[key] = targetGrid;
    const lists = node('div',undefined,'schedule-grid wide'); root.append(lists);
    parents.share_schedule = lists; parents.creative_overrides = lists;
  } else {
    grid.append(node('p','Rotation weight applies within a campaign, not to its exposure share.','wide field-help'));
    for (const [title,subtitle,keys] of [
      ['Copy','Headline, body, button and link',['eyebrow_text','headline','body_text','disclaimer_text','cta_text','click_url']],
      ['Media links','Type, links and mute setting',['media_type','video_muted_by_default','image_url','video_url','video_poster_image_url']]
    ]) {
      const panel = disclosure(title,subtitle,keys.length + ' fields');
      const content = node('div',undefined,'field-grid'); panel.append(content); root.append(panel);
      for (const key of keys) parents[key] = content;
    }
  }
  for (const key of fields[type].filter(key => !['approved','enabled'].includes(key))) {
    const choices = key === 'sponsor_id' ? catalog.sponsors.map(row => [row.id,row.name || row.id]) :
      key === 'campaign_id' ? catalog.campaigns.map(row => [row.id,row.name || row.id]) : null;
    const parent = parents[key] || grid;
    readers.push([key,['share_schedule','creative_overrides'].includes(key) ? editList(parent,key,draft.fields[key]) : editField(parent,key,draft.fields[key],choices)]);
  }
  editorRead = () => ({...Object.fromEntries(readers.map(([key,read]) => [key,read()])),
    ...(editor.kind === 'creative' ? {media_assets:{...editor.fields.media_assets}} : {})});
  if (draft.kind === 'creative') uploadControls();
  $('editor-title').tabIndex = -1; $('editor-title').focus();
}
function clearMediaPreview() {
  if (uploadTask) { uploadTask.abort(); uploadTask = null; }
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
}
function disclosure(title,subtitle,count) {
  const box = node('details',undefined,'disclosure wide');
  const summary = node('summary'), heading = node('span',undefined,'disclosure-heading');
  heading.append(node('strong',title),node('span',subtitle,'field-help'));
  summary.append(heading,node('span',count,'disclosure-count')); box.append(summary); return box;
}
function uploadControls() {
  const box = disclosure('Private draft media','Image, video and video cover','3 uploads');
  box.append(node('p',editor.id ? 'Upload a file, then save the draft to attach it. Existing uploaded files are kept; replacing an attachment does not delete files.' :
    'Save this creative draft first to enable uploads.','field-help'));
  const tabs = node('nav',undefined,'media-tabs'); tabs.setAttribute('aria-label','Private media slots');
  const zone = node('div',undefined,'draft-list'), slots = [], buttons = []; box.append(tabs);
  for (const [slot,title] of [['image','Creative image'],['video','Creative video'],['poster','Video cover image']]) {
    const wrap = node('div',undefined,'upload-layout'), id = 'upload-' + slot;
    wrap.hidden = slot !== 'image'; slots.push(wrap);
    const tab = node('button',title); tab.type = 'button'; tab.setAttribute('aria-pressed',String(slot === 'image'));
    tab.onclick = () => { slots.forEach(pane => pane.hidden = pane !== wrap); buttons.forEach(button => button.setAttribute('aria-pressed',String(button === tab))); };
    buttons.push(tab); tabs.append(tab);
    const label = node('label',title); label.htmlFor = id;
    const file = node('input'); file.id = id; file.type = 'file'; file.accept = slot === 'video' ? 'video/mp4' : 'image/jpeg,image/png,image/webp';
    file.disabled = !editor.id;
    const help = node('p',slot === 'video' ? 'MP4 Â· up to 50 MB' : 'JPEG, PNG, WebP Â· up to 10 MB','field-help');
    const status = node('p',editor.fields.media_assets[slot] ? 'A private file is attached to this draft.' : 'No private file attached.','muted'); status.setAttribute('role','status');
    const progress = node('progress'); progress.max = 100; progress.value = 0; progress.hidden = true; progress.setAttribute('aria-label',title + ' upload progress');
    const preview = node('button','Preview saved file','secondary'); preview.type = 'button'; preview.hidden = !editor.fields.media_assets[slot];
    const player = node('div',undefined,'phone-screen');
    const phone = node('div',undefined,'phone-frame'); phone.append(player);
    const controls = node('div',undefined,'upload-controls'), devices = node('div',undefined,'media-tabs');
    const deviceButtons = [];
    for (const device of ['iPhone','Android']) {
      const button = node('button',device); button.type = 'button'; button.setAttribute('aria-pressed',String(device === 'iPhone'));
      button.onclick = () => { phone.className = 'phone-frame' + (device === 'Android' ? ' android' : ''); deviceButtons.forEach(other => other.setAttribute('aria-pressed',String(other === button))); };
      deviceButtons.push(button); devices.append(button);
    }
    file.onchange = () => uploadMedia(slot,file,status,progress);
    preview.onclick = () => previewMedia(slot,preview,status,player);
    controls.append(label,file,help,status,progress,preview,node('p','Preview frame','field-help'),devices,node('p','Browser preview of the saved file. Native app layout may differ.','field-help'));
    wrap.append(controls,phone); zone.append(wrap);
  }
  box.append(zone); $('editor-fields').append(box);
}
function mediaLock(busy) {
  draftBusy = busy; $('draft-fields').disabled = busy; $('save-draft').disabled = busy; $('close-draft').disabled = busy;
}
async function uploadMedia(slot,input,status,progress) {
  const file = input.files?.[0];
  if (!file || !editor?.id || !user || draftBusy) return;
  const maximum = (slot === 'video' ? 50 : 10) * 1024 * 1024;
  const types = slot === 'video' ? ['video/mp4'] : ['image/jpeg','image/png','image/webp'];
  if (!types.includes(file.type) || !file.size || file.size > maximum || file.name.length > 200) {
    status.textContent = 'Choose a supported file within the displayed size limit.'; input.value = ''; return;
  }
  const current = editor, run = generation, uid = user.uid;
  const active = () => editor === current && generation === run && user?.uid === uid;
  mediaLock(true); status.textContent = 'Preparing private uploadâ€¦'; progress.hidden = false; progress.value = 0;
  try {
    const prepared = await prepareUpload({draft_id:current.id,slot,name:file.name,size:file.size,content_type:file.type});
    if (!active()) return;
    const data = prepared.data, url = new URL(data.upload_url);
    if (data.environment !== 'test' || !data.asset?.id || data.asset.slot !== slot || url.protocol !== 'https:' || url.hostname !== 'storage.googleapis.com' || url.username || url.password) throw Error('Invalid upload response');
    status.textContent = 'Uploading ' + file.name + 'â€¦';
    await new Promise((resolve,reject) => {
      const request = new XMLHttpRequest(); uploadTask = request;
      request.open('PUT',url.href); request.setRequestHeader('Content-Type',file.type); request.timeout = 20 * 60 * 1000;
      request.upload.onprogress = event => { if (active() && event.lengthComputable) progress.value = Math.round(event.loaded / event.total * 100); };
      request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(Error('Upload failed'));
      request.onerror = request.ontimeout = request.onabort = () => reject(Error('Upload interrupted'));
      request.send(file);
    });
    uploadTask = null; if (!active()) return;
    status.textContent = 'Checking uploaded fileâ€¦';
    const completed = await completeUpload({asset_id:data.asset.id});
    if (!active()) return;
    const result = completed.data;
    if (result.environment !== 'test' || result.asset?.status !== 'ready' || result.asset.id !== data.asset.id || result.asset.slot !== slot) throw Error('Invalid completion');
    current.fields.media_assets[slot] = result.asset.id; dirty = true; invalidateReview();
    status.textContent = 'Upload checked. Click Save draft to attach this file, then reopen its preview.';
    progress.value = 100;
  } catch (error) {
    if (!active()) return;
    if (error?.code?.includes('permission-denied') || error?.code?.includes('unauthenticated')) {
      clearLibrary(); notice('Staff access could not be confirmed. Sign in with an approved account.',true); return;
    }
    status.textContent = 'Upload did not finish or could not be validated. Your previous saved attachment is unchanged. Choose the file again to retry.';
  } finally {
    if (active()) { input.value = ''; mediaLock(false); }
  }
}
async function previewMedia(slot,button,status,player) {
  if (!editor?.id || !user || draftBusy) return;
  if (dirty) { status.textContent = 'Save the draft before previewing its attached media.'; return; }
  const current = editor, run = generation, uid = user.uid;
  const active = () => editor === current && generation === run && user?.uid === uid;
  mediaLock(true); status.textContent = 'Checking access and loading private previewâ€¦';
  try {
    const [token, attestation] = await Promise.all([user.getIdToken(), getToken(appCheck)]);
    if (!active()) return;
    const url = new URL('https://us-central1-medical-test-prep-ads-test.cloudfunctions.net/preview_ad_asset');
    url.searchParams.set('draft_id',current.id); url.searchParams.set('slot',slot);
    const response = await fetch(url,{headers:{Authorization:'Bearer ' + token,'X-Firebase-AppCheck':attestation.token},cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
    if (!active()) return;
    if (!response.ok) throw Error('Preview unavailable');
    const blob = await response.blob(); if (!active()) return;
    const allowed = slot === 'video' ? ['video/mp4'] : ['image/jpeg','image/png','image/webp'];
    if (!allowed.includes(blob.type) || blob.size > (slot === 'video' ? 50 : 10)*1024*1024) throw Error('Invalid media');
    clearMediaPreview(); previewUrl = URL.createObjectURL(blob);
    // Keep only one local preview URL alive at a time.
    for (const element of document.querySelectorAll('[data-draft-preview]')) element.remove();
    const element = node(slot === 'video' ? 'video' : 'img'); element.src = previewUrl;
    element.dataset.draftPreview = ''; element.style.maxWidth = '100%'; element.style.maxHeight = '400px';
    if (slot === 'video') { element.controls = true; element.muted = true; } else element.alt = 'Private creative preview';
    player.replaceChildren(element); status.textContent = 'Private preview loaded. This does not serve an ad or record an impression.';
  } catch {
    if (active()) status.textContent = 'Preview could not load. Check your connection and staff access, then try again.';
  } finally { if (active()) mediaLock(false); }
}

function invalidateReview() {
  ++reviewRequest;
  $('draft-review').replaceChildren(); $('draft-review').hidden = true;
}
function validateReview(data, draft) {
  if (!data || data.environment !== 'test' || data.activation_performed !== false || data.draft_id !== draft.id ||
      data.revision !== draft.revision || data.kind !== draft.kind || data.target_id !== draft.target_id ||
      typeof data.checks_passed !== 'boolean' || !Number.isFinite(Date.parse(data.reviewed_at)) ||
      typeof data.basis !== 'string' || data.basis.length > 2000 || !Array.isArray(data.issues) || data.issues.length > 500 ||
      !Array.isArray(data.changes) || data.changes.length > 30) throw Error('Invalid review response');
  for (const issue of data.issues) {
    if (!issue || !['error','warning'].includes(issue.severity) || typeof issue.field !== 'string' ||
        typeof issue.message !== 'string' || issue.message.length > 4000) throw Error('Invalid review issue');
  }
  if (data.checks_passed === data.issues.some(issue => issue.severity === 'error')) throw Error('Inconsistent review result');
  const allowed = fields[draft.kind === 'campaign' ? 'campaigns' : 'creatives'].filter(key => !['approved','enabled'].includes(key));
  if (draft.kind === 'creative') allowed.push('media_assets');
  const seen = new Set();
  for (const change of data.changes) {
    if (!change || !allowed.includes(change.field) || seen.has(change.field) ||
        !Object.hasOwn(change,'before') || !Object.hasOwn(change,'after') ||
        JSON.stringify(change).length > 100000) throw Error('Invalid proposed changes');
    seen.add(change.field);
  }
  return data;
}
function reviewValue(key, value) {
  if (value == null) return 'Not set';
  if (key === 'media_assets') return Object.keys(value).length ? Object.keys(value).map(slot =>
    (slot === 'poster' ? 'Video cover image' : slot === 'video' ? 'Video' : 'Image') + ': private attachment').join('\n') : 'No private attachments';
  if (['share_schedule','creative_overrides'].includes(key)) {
    if (!value.length) return 'None';
    return value.map((entry,index) => key === 'share_schedule' ?
      'Period ' + (index+1) + ': ' + (entry.percent ?? 'Not set') + '%\n' + display('start_at',entry.start_at) + '\nUntil: ' + display('end_at',entry.end_at) :
      'Override ' + (index+1) + ': ' + (entry.placement || 'Not set') + ' Â· Exam: ' + (entry.exam || 'All') + ' Â· Module: ' + (entry.module || 'All') + '\nCreatives: ' + (entry.creative_ids || []).map(id => name('creatives',id)).join(', ')).join('\n\n');
  }
  return display(key,value);
}
function showReview(data, finalSummary = false) {
  const box = $('draft-review'); box.replaceChildren(); box.hidden = false;
  const heading = node('h2',data.checks_passed ? 'No blocking issues found' : 'Draft needs attention'); heading.tabIndex = -1;
  box.append(heading,node('p','Saved revision ' + data.revision + ' Â· Draft ID: ' + data.draft_id + ' Â· Reviewed ' + localTime(data.reviewed_at),'muted'),
    node('p',finalSummary ? 'Final publishing summary. Confirm below to update campaign settings used for ad delivery in the test project.' : 'Review only. No ad was approved, published, or activated.'),node('p',data.basis,'muted'));
  for (const severity of ['error','warning']) {
    const items = data.issues.filter(issue => issue.severity === severity);
    if (!items.length) continue;
    box.append(node('h3',severity === 'error' ? 'Blocking issues' : 'Warnings'));
    const list = node('ul');
    for (const issue of items) list.append(node('li',(labels[issue.field] || ({media_assets:'Private media',configuration:'Configuration',changes:'Changes',target_id:'Existing record'})[issue.field] || issue.field) + ': ' + issue.message));
    box.append(list);
  }
  box.append(node('h3',data.target_id ? 'Proposed changes to existing record' : 'Proposed new record'));
  const list = node('dl');
  for (const change of data.changes) {
    list.append(node('dt',labels[change.field] || 'Private media'),node('dd','Current: ' + reviewValue(change.field,change.before) + '\nProposed: ' + reviewValue(change.field,change.after)));
  }
  box.append(data.changes.length ? list : node('p','No editable field changes.'));
  if (!finalSummary && data.kind === 'campaign' && data.target_id && data.checks_passed && data.changes.length) {
    const prepare = node('button','Prepare publishing summary'); prepare.type = 'button';
    prepare.onclick = () => campaignPublish(); box.append(prepare);
  }
  heading.focus();
}
async function campaignPublish(confirmation = null, preparedTicket = null) {
  if (!editor || !user || draftBusy || dirty || !editor.id || editor.kind !== 'campaign' || !editor.target_id) return;
  if (confirmation && preparedTicket !== reviewRequest) return;
  const current = editor, run = generation, uid = user.uid, ticket = reviewRequest;
  const active = () => editor === current && generation === run && user?.uid === uid && ticket === reviewRequest;
  mediaLock(true); $('review-draft').disabled = true;
  $('draft-status').textContent = confirmation ? 'Publishing the confirmed campaign settingsâ€¦' : 'Preparing the final publishing summaryâ€¦';
  try {
    const response = confirmation ? await publishCampaignDraft({draft_id:current.id,expected_revision:current.revision,confirmation}) :
      await prepareCampaignPublish({draft_id:current.id,expected_revision:current.revision});
    if (!active()) return;
    const data = response.data;
    if (!confirmation) {
      const review = validateReview(data?.review,current);
      if (data.environment !== 'test' || !/^[0-9a-f]{64}$/.test(data.confirmation || '') ||
          !review.checks_passed || !review.changes.length || review.kind !== 'campaign' || !review.target_id ||
          typeof data.preserved_flags?.approved !== 'boolean' || typeof data.preserved_flags?.enabled !== 'boolean') throw Error('Invalid publishing summary');
      showReview(review,true);
      const flags = data.preserved_flags;
      $('draft-review').append(node('p','Values preserved: Approved: ' + display('approved',flags.approved) + ' Â· Enabled: ' + display('enabled',flags.enabled)));
      const publish = node('button','Publish campaign settings','primary'); publish.type = 'button';
      publish.onclick = () => campaignPublish(data.confirmation,ticket); $('draft-review').append(publish);
      $('draft-status').textContent = 'Check the exact changes and warnings above, then choose Publish campaign settings to confirm.';
    } else {
      if (data?.environment !== 'test' || data.draft_id !== current.id || data.revision !== current.revision ||
          data.target_id !== current.target_id || data.settings_published !== true || typeof data.history_id !== 'string' ||
          !/^[0-9a-f]{64}$/.test(data.history_id) || !Number.isFinite(Date.parse(data.published_at))) throw Error('Invalid publication receipt');
      await load();
      if (user?.uid === uid) notice('Campaign settings published in the test project. Approval and enabled values were preserved.');
    }
  } catch (error) {
    if (!active()) return;
    invalidateReview();
    if (error?.code?.includes('permission-denied') || error?.code?.includes('unauthenticated')) {
      clearLibrary(); notice('Staff publishing access could not be confirmed. Sign in with an approved account.',true); return;
    }
    $('draft-status').textContent = error?.code?.includes('aborted') ?
      'The draft or stored catalog changed. Review again and prepare a new publishing summary.' :
      confirmation ? 'Publication could not be confirmed. Refresh the library and review the current campaign before trying again; the request may have completed.' :
      'A publishing summary could not be prepared. Review the saved draft and correct any blocking issues, then try again.';
  } finally {
    if (generation === run && user?.uid === uid && editor === current) { mediaLock(false); $('review-draft').disabled = false; }
  }
}
$('review-draft').onclick = async () => {
  if (!editor || !user || draftBusy) return;
  invalidateReview();
  if (!editor.id || dirty) { $('draft-status').textContent = 'Save your draft changes before reviewing the saved revision.'; return; }
  const current = editor, run = generation, uid = user.uid, ticket = reviewRequest;
  const active = () => editor === current && generation === run && user?.uid === uid && ticket === reviewRequest;
  mediaLock(true); $('review-draft').disabled = true; $('draft-status').textContent = 'Reviewing the saved draft and stored configurationâ€¦';
  try {
    const response = await fetchReview({draft_id:current.id,expected_revision:current.revision});
    if (!active()) return;
    showReview(validateReview(response.data,current)); $('draft-status').textContent = 'Saved draft reviewed. No ad delivery changed.';
  } catch (error) {
    if (!active()) return;
    if (error?.code?.includes('permission-denied') || error?.code?.includes('unauthenticated')) {
      clearLibrary(); notice('Staff review access could not be confirmed. Sign in with an approved account.',true); return;
    }
    $('draft-status').textContent = error?.code?.includes('aborted') ?
      'This draft changed in another page. Reload its saved version before reviewing.' :
      'The review could not be completed. Check your connection or ask your administrator to check the stored catalog. No partial review or approval was issued.';
  } finally {
    if (generation === run && user?.uid === uid && editor === current) mediaLock(false);
    if (generation === run) $('review-draft').disabled = false;
  }
};

function leaveEditor() {
  if (draftBusy || (dirty && !window.confirm('Discard unsaved draft changes and return to the library?'))) return false;
  clearMediaPreview(); invalidateReview();
  editor = null; editorRead = null; dirty = false; ++draftRequest;
  $('editor-fields').replaceChildren(); $('draft-editor').hidden = true; $('browse-panel').hidden = false; render(); return true;
}
$('draft-form').oninput = () => { dirty = true; invalidateReview(); };
$('draft-form').onchange = () => { dirty = true; invalidateReview(); };
$('close-draft').onclick = leaveEditor;
$('new-campaign').onclick = () => openEditor({kind:'campaign',target_id:null,fields:{}});
$('new-creative').onclick = () => openEditor({kind:'creative',target_id:null,fields:{}});
$('tab-drafts').onclick = () => switchSection('drafts');
$('reload-draft').onclick = () => {
  if (editor?.id && !draftBusy && (!dirty || window.confirm('Discard your unsaved changes and load the latest saved version?'))) readDraft(editor.id,$('reload-draft'));
};
window.addEventListener('beforeunload',event => { if (dirty || draftBusy || campaignPauseBusy) { event.preventDefault(); event.returnValue = ''; } });
$('draft-form').onsubmit = async event => {
  event.preventDefault(); if (!editor || !user || draftBusy) return;
  const run = generation, uid = user.uid, current = editor;
  let values;
  try { values = editorRead(); }
  catch { $('draft-status').textContent = 'Check the dates and field values before saving.'; return; }
  invalidateReview();
  draftBusy = true; $('draft-fields').disabled = true; $('save-draft').disabled = true; $('close-draft').disabled = true;
  $('reload-draft').hidden = true; $('draft-status').textContent = 'Saving draftâ€¦';
  try {
    const response = await persistDraft({draft_id:current.id || null,expected_revision:current.revision || 0,
      kind:current.kind,target_id:current.target_id,fields:values});
    if (run !== generation || user?.uid !== uid || editor !== current) return;
    if (response.data?.environment !== 'test') throw Error('Invalid draft response');
    const saved = validDraft(response.data.draft,true);
    if (saved.kind !== current.kind || saved.target_id !== current.target_id || (current.id && saved.id !== current.id)) throw Error('Unexpected draft');
    drafts = [saved,...drafts.filter(row => row.id !== saved.id)].sort((a,b) => b.updated_at.localeCompare(a.updated_at));
    openEditor(saved); $('draft-status').textContent = 'Draft saved. Served ads have not changed.';
  } catch (error) {
    if (run !== generation || user?.uid !== uid || editor !== current) return;
    if (error?.code?.includes('permission-denied') || error?.code?.includes('unauthenticated')) {
      clearLibrary(); notice('Staff access could not be confirmed. Sign in with an approved account.',true); return;
    }
    const conflict = error?.code?.includes('aborted');
    $('draft-status').textContent = conflict ? 'Someone else saved this draft. Your edits are still here and were not saved. Copy anything you want to keep before reloading the saved version.' :
      error?.code?.includes('invalid-argument') ? 'Draft could not save. Check HTTPS links, whole-number weights and shares, and that each end time follows its start time. Your edits are still here.' :
      'Save could not be confirmed. Your edits are still here. Refresh the draft list before retrying a new draft to avoid creating a duplicate.';
    $('reload-draft').hidden = !conflict || !current.id;
  } finally {
    if (run === generation && user?.uid === uid && editor) {
      draftBusy = false; $('draft-fields').disabled = false; $('save-draft').disabled = false; $('close-draft').disabled = false;
    }
  }
};

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
  if ((dirty || draftBusy || campaignPauseBusy) && !window.confirm('Leave this editor and sign out? Any unsaved changes will be discarded. A save, publication, or pause already sent may still finish.')) return;
  ++generation; clearLibrary(); resetLink(); $('email').value = '';
  try { await signOut(auth); } catch { notice('Sign-out could not finish. Close this tab to end this session.',true); }
};
$('refresh').onclick = load;
$('sponsor-filter').onchange = () => { if (!catalog) return; selected = null; updateCampaigns(); render(); };
$('campaign-filter').onchange = () => { selected = null; render(); };
function switchSection(type) {
  section = type; selected = null; detailTab = 'Overview'; $('library-search').value = ''; $('record-status').value = 'all'; render();
}
for (const type of Object.keys(fields)) $('tab-' + type).onclick = () => switchSection(type);
$('library-search').oninput = () => { selected = null; render(); };
$('record-status').onchange = () => { selected = null; render(); };
$('search-form').onsubmit = event => { event.preventDefault(); selected = null; render(); };
try {
  await setPersistence(auth,browserSessionPersistence);
  onAuthStateChanged(auth,handleUser); ready = true; authControls(false);
} catch { clearLibrary(); notice('A secure sign-in session could not start. Check browser storage settings and reload.',true); }
