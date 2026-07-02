// Daily event-reminder digest for the /us.html calendar.
// Runs from .github/workflows/reminders.yml on a cron schedule.
// Reads events from Supabase with the SECRET key (bypasses RLS),
// figures out what is happening soon, and emails a digest via Resend.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hqkbqztcsxaafmshbyrb.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.REMINDER_FROM || 'oss <reminders@pflo.org>';
const TO = (process.env.REMINDER_TO ||
  'pgrindehollevik@g.harvard.edu,Molly.kvam.mccarthy@gmail.com')
  .split(',').map(s => s.trim()).filter(Boolean);
const TZ = process.env.REMINDER_TZ || 'Europe/Oslo';   // reference zone for "today"
const BIRTHDAY_LEAD_DAYS = Number(process.env.BIRTHDAY_LEAD_DAYS || 7);

function softExit(msg) { console.log(msg); process.exit(0); }

if (!SERVICE_KEY) softExit('SUPABASE_SERVICE_KEY not set, skipping.');
if (!RESEND_API_KEY) softExit('RESEND_API_KEY not set yet, skipping send.');

/* ---- date helpers (date-only math in the reference timezone) ---- */
function ymdInTz(date) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, m, d] = f.format(date).split('-').map(Number);
  return { y, m, d };
}
function dayNum(y, m, d) { return Math.floor(Date.UTC(y, m - 1, d) / 86400000); }

const now = new Date();
const t = ymdInTz(now);
const todayNum = dayNum(t.y, t.m, t.d);

function fmtDate(iso) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(iso));
}
function fmtTime(iso) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
    .format(new Date(iso));
}
function whenText(ev) {
  let s = fmtDate(ev.starts_at);
  if (!ev.all_day) s += ', ' + fmtTime(ev.starts_at);
  if (ev.ends_at) {
    s += ' to ' + fmtDate(ev.ends_at);
    if (!ev.all_day) s += ', ' + fmtTime(ev.ends_at);
  }
  return s;
}
function addedBy(ev) {
  return (ev.created_by && ev.created_by !== 'seed') ? ' · added by ' + ev.created_by : '';
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---- load events ---- */
let events;
try {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/events?select=*`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  });
  if (!res.ok) { console.error('Failed to load events:', res.status, await res.text()); process.exit(1); }
  events = await res.json();
} catch (err) {
  console.error('Error loading events:', err);
  process.exit(1);
}

/* ---- classify ---- */
function eventDayNum(ev) { const { y, m, d } = ymdInTz(new Date(ev.starts_at)); return dayNum(y, m, d); }
function birthdayInfo(ev) {
  const ref = new Date(ev.starts_at);
  const m = ref.getUTCMonth() + 1, d = ref.getUTCDate();
  let occNum = dayNum(t.y, m, d);
  if (occNum < todayNum) occNum = dayNum(t.y + 1, m, d);
  return { daysAway: occNum - todayNum, m, d };
}

const today = [], tomorrow = [], birthdays = [];
let nextReunion = null;

for (const ev of events) {
  if (ev.recurrence === 'yearly') {
    const b = birthdayInfo(ev);
    if (b.daysAway === 0 || b.daysAway === BIRTHDAY_LEAD_DAYS) birthdays.push({ ev, ...b });
    continue;
  }
  const diff = eventDayNum(ev) - todayNum;
  if (diff === 0) today.push(ev);
  else if (diff === 1) tomorrow.push(ev);

  if (ev.is_reunion) {
    const startMs = new Date(ev.starts_at).getTime();
    if (startMs >= now.getTime() &&
        (!nextReunion || startMs < new Date(nextReunion.starts_at).getTime())) {
      nextReunion = ev;
    }
  }
}
birthdays.sort((a, b) => a.daysAway - b.daysAway);

if (!today.length && !tomorrow.length && !birthdays.length) {
  softExit('Nothing to remind about today.');
}

/* ---- build email ---- */
function evRow(ev) {
  const heart = ev.is_reunion ? '❤️ ' : '';
  return `<tr><td style="padding:7px 0;border-bottom:1px solid #eee;">
    <div style="font-size:14px;color:#111;">${heart}${esc(ev.title)}</div>
    <div style="font-size:12px;color:#666;margin-top:2px;">${esc(whenText(ev) + addedBy(ev))}</div>
  </td></tr>`;
}
function bdayRow(b) {
  const when = b.daysAway === 0 ? 'today' : (b.daysAway === 1 ? 'tomorrow' : `in ${b.daysAway} days`);
  const dateTxt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
    .format(new Date(Date.UTC(2000, b.m - 1, b.d)));
  return `<tr><td style="padding:7px 0;border-bottom:1px solid #eee;">
    <div style="font-size:14px;color:#111;">🎂 ${esc(b.ev.title)}</div>
    <div style="font-size:12px;color:#666;margin-top:2px;">${when} · ${dateTxt}</div>
  </td></tr>`;
}
function section(title, rowsHtml) {
  return `<div style="margin:18px 0 4px;color:#AD7C03;font-weight:700;font-size:13px;
    text-transform:lowercase;letter-spacing:.03em;">${title}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table>`;
}

const parts = [];
if (today.length) parts.push(section('today', today.map(evRow).join('')));
if (tomorrow.length) parts.push(section('tomorrow', tomorrow.map(evRow).join('')));
if (birthdays.length) parts.push(section('birthdays coming up', birthdays.map(bdayRow).join('')));

let footer = '';
if (nextReunion) {
  const days = Math.max(0, Math.ceil((new Date(nextReunion.starts_at).getTime() - now.getTime()) / 86400000));
  footer = `${days} ${days === 1 ? 'day' : 'days'} until you are together again ❤️<br>
    <span style="color:#888;">${esc(nextReunion.title)} · ${esc(fmtDate(nextReunion.starts_at))}</span>`;
}

const html = `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;background:#fff;">
  <div style="max-width:480px;margin:0 auto;padding:24px 18px;
    font:14px/1.5 Arial,Helvetica,sans-serif;color:#111;">
    <div style="color:#AD7C03;font-weight:700;font-size:17px;border-bottom:1px solid #222;padding-bottom:8px;">oss</div>
    ${parts.join('')}
    ${footer ? `<div style="margin-top:22px;padding-top:12px;border-top:1px solid #eee;font-size:13px;color:#111;">${footer}</div>` : ''}
    <div style="margin-top:20px;font-size:11px;color:#aaa;">
      <a href="https://pflo.org/us.html" style="color:#1a2d5f;">open the calendar</a>
    </div>
  </div>
</body></html>`;

/* plain-text fallback */
const textParts = [];
function evText(ev) { return `- ${ev.is_reunion ? '❤️ ' : ''}${ev.title}, ${whenText(ev)}${addedBy(ev)}`; }
if (today.length) textParts.push('TODAY\n' + today.map(evText).join('\n'));
if (tomorrow.length) textParts.push('TOMORROW\n' + tomorrow.map(evText).join('\n'));
if (birthdays.length) textParts.push('BIRTHDAYS COMING UP\n' + birthdays.map(b => {
  const when = b.daysAway === 0 ? 'today' : (b.daysAway === 1 ? 'tomorrow' : `in ${b.daysAway} days`);
  return `- ${b.ev.title} (${when})`;
}).join('\n'));
if (nextReunion) {
  const days = Math.max(0, Math.ceil((new Date(nextReunion.starts_at).getTime() - now.getTime()) / 86400000));
  textParts.push(`${days} ${days === 1 ? 'day' : 'days'} until you are together again: ${nextReunion.title}, ${fmtDate(nextReunion.starts_at)}`);
}
const text = 'oss\n\n' + textParts.join('\n\n') + '\n\nhttps://pflo.org/us.html';

/* subject line */
let subject;
if (today.length) subject = `oss · today: ${today[0].title}${today.length > 1 ? ` (+${today.length - 1})` : ''}`;
else if (tomorrow.length) subject = `oss · tomorrow: ${tomorrow[0].title}${tomorrow.length > 1 ? ` (+${tomorrow.length - 1})` : ''}`;
else {
  const b = birthdays[0];
  const when = b.daysAway === 0 ? 'today' : (b.daysAway === 1 ? 'tomorrow' : `in ${b.daysAway} days`);
  subject = `oss · ${b.ev.title} ${when}`;
}

/* ---- send via Resend ---- */
try {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: TO, subject, html, text })
  });
  if (!res.ok) { console.error('Resend error:', res.status, await res.text()); process.exit(1); }
  console.log('Reminder sent to', TO.join(', '), '·', subject);
} catch (err) {
  console.error('Error sending email:', err);
  process.exit(1);
}
