/**
 * IZIKI — Demo submissions backend (Google Apps Script)
 *
 * Receives demos from the GitHub Pages form, stores them in the Google Sheet
 * this script is attached to, emails the label, and sends the artist a
 * branded confirmation. See README.md for setup.
 */

// ---------- settings ----------
var CONFIG = {
  LABEL_NAME: 'IZIKI',
  NOTIFY_EMAIL: 'you@example.com',     // where new-demo alerts go (comma-separate for several)
  REPLY_TO: 'you@example.com',         // reply-to on the artist confirmation
  SHEET_NAME: 'Demos',
  MIN_DAYS_BETWEEN: 30,                // one submission per email per N days (0 = off)
  SEND_CONFIRMATION: true,
  REVIEW_WEEKS: 4
};

var HEADERS = [
  'Received', 'Status', 'Rating', 'Artist', 'Real name', 'Email', 'Location',
  'Beatport', 'SoundCloud', 'Spotify', 'Instagram', 'Resident Advisor', 'Website',
  'Tracks', 'Listen link', 'Download link', 'Style',
  'BPM', 'Release type', 'Previous releases', 'Note', 'Found us via',
  'Rights confirmed', 'No AI confirmed', 'Consent', 'Internal notes', 'ID'
];

var STATUSES = ['New', 'Listening', 'Shortlist', 'Offer sent', 'Signed', 'Pass'];

// ---------- web endpoints ----------
function doGet() {
  return json_({ ok: true, label: CONFIG.LABEL_NAME, service: 'demo-inbox' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var d = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (d.website) return json_({ ok: true }); // honeypot: pretend success for bots

    var err = validate_(d);
    if (err) return json_({ ok: false, error: err });

    var sheet = sheet_();
    if (CONFIG.MIN_DAYS_BETWEEN > 0 && recentlySubmitted_(sheet, d.email)) {
      return json_({ ok: false, error: 'We already have a demo from this email in the last ' +
        CONFIG.MIN_DAYS_BETWEEN + ' days. We\'ll listen to that one first.' });
    }

    var id = 'IZK-' + Utilities.formatDate(new Date(), 'Etc/UTC', 'yyMMdd') + '-' +
             Math.random().toString(36).slice(2, 6).toUpperCase();

    sheet.appendRow([
      new Date(), 'New', '', s_(d.artist), s_(d.realName), s_(d.email).toLowerCase(), s_(d.location),
      s_(d.beatport), s_(d.soundcloud), s_(d.spotify), s_(d.instagram), s_(d.ra), s_(d.site),
      s_(d.tracks), s_(d.link), s_(d.download), s_(d.style),
      s_(d.bpm), s_(d.type), s_(d.previous), s_(d.note), s_(d.heard),
      d.owned ? 'Yes' : 'No', d.noAI ? 'Yes' : 'No', d.consent ? 'Yes' : 'No', '', id
    ]);

    notifyLabel_(d, id);
    if (CONFIG.SEND_CONFIRMATION) confirmArtist_(d, id);

    return json_({ ok: true, id: id });
  } catch (x) {
    console.error(x);
    return json_({ ok: false, error: 'Something went wrong on our side. Please try again in a moment.' });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// ---------- helpers ----------
function validate_(d) {
  if (!s_(d.artist)) return 'Please add your artist name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s_(d.email))) return 'Please check your email address.';
  if (!s_(d.tracks)) return 'Please add your track title(s).';
  if (!/^https?:\/\/\S+$/i.test(s_(d.link))) return 'Please add a valid listening link (starting with https://).';
  if (!s_(d.style)) return 'Please choose Afro house, tech house or both.';
  if (!d.owned) return 'Please confirm the music is yours and unreleased.';
  if (!d.noAI) return 'Please confirm the music was not made with AI. We don\'t accept AI-generated tracks.';
  if (!d.consent) return 'Please agree that we may store your details.';
  return '';
}

function s_(v) {
  v = (v == null ? '' : String(v)).trim().slice(0, 1000);
  return /^[=+\-@]/.test(v) ? "'" + v : v; // stop formula injection in Sheets
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(CONFIG.SHEET_NAME); }
  if (sh.getLastRow() === 0) setupSheet();
  return sh;
}

function recentlySubmitted_(sheet, email) {
  var last = sheet.getLastRow();
  if (last < 2) return false;
  var rows = sheet.getRange(2, 1, last - 1, 6).getValues(); // Received … Email
  var cutoff = Date.now() - CONFIG.MIN_DAYS_BETWEEN * 864e5;
  email = s_(email).toLowerCase();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][5]).toLowerCase() === email && new Date(rows[i][0]).getTime() > cutoff) return true;
  }
  return false;
}

function esc_(v) {
  return String(v || '').replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function notifyLabel_(d, id) {
  if (!CONFIG.NOTIFY_EMAIL || CONFIG.NOTIFY_EMAIL.indexOf('example.com') > -1) return;
  var url = SpreadsheetApp.getActiveSpreadsheet().getUrl();
  var rows = [
    ['Artist', d.artist], ['Email', d.email], ['From', d.location], ['Beatport', d.beatport],
    ['SoundCloud', d.soundcloud], ['Spotify', d.spotify], ['Instagram', d.instagram],
    ['Resident Advisor', d.ra], ['Website', d.site],
    ['Tracks', d.tracks], ['Style', d.style], ['BPM', d.bpm], ['Type', d.type],
    ['Previous', d.previous], ['Note', d.note]
  ].filter(function (r) { return r[1]; }).map(function (r) {
    return '<tr><td style="padding:4px 14px 4px 0;color:#9a8a72;vertical-align:top">' + r[0] +
           '</td><td style="padding:4px 0">' + esc_(r[1]) + '</td></tr>';
  }).join('');

  MailApp.sendEmail({
    to: CONFIG.NOTIFY_EMAIL,
    replyTo: s_(d.email),
    subject: 'New demo · ' + s_(d.artist) + ' — ' + s_(d.tracks),
    htmlBody:
      '<div style="font-family:Georgia,serif;color:#2b2522">' +
      '<p style="font:800 12px Arial,sans-serif;letter-spacing:.2em;color:#ea6356">NEW DEMO · ' + id + '</p>' +
      '<p><a href="' + esc_(d.link) + '" style="font:800 16px Arial,sans-serif;color:#2b2522">▶ Listen</a>' +
      (d.download ? ' &nbsp;·&nbsp; <a href="' + esc_(d.download) + '">Download</a>' : '') + '</p>' +
      '<table style="font-size:14px">' + rows + '</table>' +
      '<p style="margin-top:18px"><a href="' + url + '">Open the demo sheet</a></p></div>'
  });
}

function confirmArtist_(d, id) {
  var name = esc_(d.artist);
  MailApp.sendEmail({
    to: s_(d.email),
    replyTo: CONFIG.REPLY_TO,
    name: CONFIG.LABEL_NAME,
    subject: 'We received your demo — ' + CONFIG.LABEL_NAME,
    htmlBody:
      '<div style="background:#2b2522;padding:36px 28px;font-family:Georgia,serif;color:#f3e6cc;line-height:1.6">' +
      '<p style="font:800 14px Arial,sans-serif;letter-spacing:.32em;margin:0 0 24px">IZIKI</p>' +
      '<p style="font:800 26px Arial,sans-serif;line-height:1.1;margin:0 0 18px">Your music is <span style="color:#8fc06a">through the gate.</span></p>' +
      '<p>Hi ' + name + ',</p>' +
      '<p>Thank you for sending us <b>' + esc_(d.tracks) + '</b>. Every demo that reaches IZIKI gets a proper listen.</p>' +
      '<p>If it\'s a fit for the label we\'ll get back to you within ' + CONFIG.REVIEW_WEEKS +
      ' weeks. Please keep the link active until then.</p>' +
      '<p style="color:#c9b79a;font-size:13px;margin-top:28px">Reference: ' + id + '</p></div>'
  });
}

// ---------- one-time setup (run from the editor) ----------
function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setBackground('#2b2522').setFontColor('#eda644');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(4);

  var n = sh.getMaxRows() - 1;
  sh.getRange(2, 2, n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build());
  sh.getRange(2, 3, n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['★', '★★', '★★★', '★★★★', '★★★★★'], true).build());
  sh.getRange(2, 1, n, 1).setNumberFormat('yyyy-mm-dd hh:mm');

  var col = sh.getRange(2, 2, n, 1), rules = [];
  [['New', '#fdf0d8'], ['Listening', '#e7e6f7'], ['Shortlist', '#fbe2c2'],
   ['Offer sent', '#fcd9d4'], ['Signed', '#dff0d2'], ['Pass', '#eeeeee']].forEach(function (p) {
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(p[0]).setBackground(p[1]).setRanges([col]).build());
  });
  sh.setConditionalFormatRules(rules);
  [150, 100, 80, 160].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
}

/** Run once from the editor to check emails + sheet work. */
function testSubmission() {
  var r = doPost({ postData: { contents: JSON.stringify({
    artist: 'Test Artist', email: CONFIG.REPLY_TO, tracks: 'Test Track', link: 'https://soundcloud.com/test',
    style: 'Afro house', bpm: '122', owned: true, noAI: true, consent: true
  }) } });
  Logger.log(r.getContent());
}
