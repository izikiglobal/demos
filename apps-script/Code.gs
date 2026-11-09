/**
 * IZIKI — Demo submissions backend + Listening Room (Google Apps Script)
 *
 * 1. Receives demos from the GitHub Pages form, stores them in the "Demos" tab,
 *    emails the label and sends the artist a confirmation.
 * 2. Serves the private Listening Room, where the team plays each track and
 *    rates its IZIKI fit (1–5 stars).
 * 3. On the 1st of every month, picks last month's best demo and emails it.
 *
 * Files in this project: Code.gs (this file) and Room.html. See README.md.
 */

// ---------- settings ----------
var CONFIG = {
  LABEL_NAME: 'IZIKI',
  SHEET_ID: '',                         // ID of the IZIKI Demos sheet (from its URL); empty = sheet this script is attached to
  WEB_APP_URL: '',                      // published web app URL (…/exec), used in Listening Room links
  NOTIFY_EMAIL: 'izikiteam@gmail.com',  // new-demo alerts + monthly pick (comma-separate for several)
  REPLY_TO: 'izikiteam@gmail.com',      // reply-to on the artist confirmation
  TEAM: ['Danielle', 'Mikkas'],         // listeners in the Listening Room
  SHEET_NAME: 'Demos',
  RATINGS_SHEET: 'Ratings',
  PICKS_SHEET: 'Demo of the month',
  TIMEZONE: 'Europe/Copenhagen',
  MIN_DAYS_BETWEEN: 30,                 // one submission per email per N days (0 = off)
  SEND_CONFIRMATION: true,
  REVIEW_WEEKS: 4
};

var HEADERS = [
  'Received', 'Status', 'IZIKI fit', 'Artist', 'Real name', 'Email', 'Location',
  'Beatport', 'SoundCloud', 'Spotify', 'Instagram', 'Website',
  'Tracks', 'Listen link', 'Download link', 'Style',
  'BPM', 'Release type', 'Previous releases', 'Note', 'Found us via',
  'Rights confirmed', 'No AI confirmed', 'Consent', 'Internal notes', 'ID'
];
var RATING_HEADERS = ['Rated at', 'Demo ID', 'Track #', 'Track', 'Artist', 'Listener', 'IZIKI fit', 'Comment'];
var PICK_HEADERS = ['Month', 'Demo ID', 'Artist', 'Track', 'IZIKI fit (avg)', 'Ratings', 'Listen link', 'Email'];

var STATUSES = ['New', 'Listening', 'Shortlist', 'Offer sent', 'Signed', 'Pass'];

// ---------- web endpoints ----------
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.view === 'room') {
    if (p.key !== roomKey_()) {
      return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">This link is not valid.</p>');
    }
    var t = HtmlService.createTemplateFromFile('Room');
    t.key = p.key;
    t.who = CONFIG.TEAM.indexOf(p.who) > -1 ? p.who : '';
    t.team = JSON.stringify(CONFIG.TEAM);
    t.base = baseUrl_();
    return t.evaluate()
      .setTitle('IZIKI · Listening Room')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
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
      s_(d.beatport), s_(d.soundcloud), s_(d.spotify), s_(d.instagram), s_(d.site),
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

// ---------- Listening Room API (called from Room.html) ----------
function roomData(key) {
  checkKey_(key);
  var demos = rows_(sheet_()).map(function (r) {
    return {
      id: r['ID'], received: iso_(r['Received']), status: r['Status'] || 'New',
      artist: r['Artist'], location: r['Location'], email: r['Email'],
      beatport: r['Beatport'], soundcloud: r['SoundCloud'], spotify: r['Spotify'],
      instagram: r['Instagram'], website: r['Website'],
      tracks: tracks_(r), download: r['Download link'], type: r['Release type'],
      previous: r['Previous releases'], note: r['Note'], notes: r['Internal notes']
    };
  }).filter(function (d) { return d.id; });
  var ratings = rows_(ratingsSheet_()).map(function (r) {
    return { id: r['Demo ID'], track: Number(r['Track #']), who: r['Listener'],
             stars: Number(r['IZIKI fit']), comment: r['Comment'] };
  });
  return JSON.stringify({ demos: demos.reverse(), ratings: ratings, team: CONFIG.TEAM });
}

function rateTrack(key, who, id, trackNo, stars, comment) {
  checkKey_(key);
  if (CONFIG.TEAM.indexOf(who) < 0) throw new Error('Unknown listener');
  stars = Math.round(Number(stars));
  if (!(stars >= 1 && stars <= 5)) throw new Error('Stars must be 1–5');
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var demo = findDemo_(id);
    if (!demo) throw new Error('Demo not found');
    var track = demo.tracks[trackNo - 1] || { title: '' };
    var sh = ratingsSheet_(), last = sh.getLastRow();
    var row = [new Date(), id, trackNo, track.title, demo.row['Artist'], who, stars, s_(comment)];
    if (last > 1) {
      var v = sh.getRange(2, 1, last - 1, 6).getValues();
      for (var i = 0; i < v.length; i++) {
        if (v[i][1] === id && Number(v[i][2]) === Number(trackNo) && v[i][5] === who) {
          sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
          updateDemoScore_(id);
          return true;
        }
      }
    }
    sh.appendRow(row);
    updateDemoScore_(id);
    var s = sheet_(), col = HEADERS.indexOf('Status') + 1;
    if (s.getRange(demo.rowNum, col).getValue() === 'New') s.getRange(demo.rowNum, col).setValue('Listening');
    return true;
  } finally { lock.releaseLock(); }
}

function setStatus(key, id, status) {
  checkKey_(key);
  if (STATUSES.indexOf(status) < 0) throw new Error('Unknown status');
  var demo = findDemo_(id);
  if (!demo) throw new Error('Demo not found');
  sheet_().getRange(demo.rowNum, HEADERS.indexOf('Status') + 1).setValue(status);
  return true;
}

function saveNotes(key, id, text) {
  checkKey_(key);
  var demo = findDemo_(id);
  if (!demo) throw new Error('Demo not found');
  sheet_().getRange(demo.rowNum, HEADERS.indexOf('Internal notes') + 1).setValue(s_(text));
  return true;
}

// ---------- Demo of the month ----------
/** Runs on the 1st of each month (trigger made by setup). Picks last month's best demo. */
function monthlyPick() {
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var end = new Date(now.getFullYear(), now.getMonth(), 1);
  var month = Utilities.formatDate(start, CONFIG.TIMEZONE, 'MMMM yyyy');
  var best = bestOf_(start, end);
  var room = roomLinks_()[0].url;

  if (!best) {
    MailApp.sendEmail({ to: CONFIG.NOTIFY_EMAIL, subject: 'IZIKI · Demo of the month · ' + month,
      htmlBody: '<p>No rated demos for ' + month + '.</p>' });
    return;
  }
  var ps = picksSheet_();
  ps.appendRow([month, best.id, best.artist, best.title, best.avg, best.count, best.url, best.email]);

  MailApp.sendEmail({
    to: CONFIG.NOTIFY_EMAIL,
    subject: 'IZIKI · Demo of the month · ' + month + ' — ' + best.artist,
    htmlBody:
      '<div style="background:#2b2522;padding:32px 26px;font-family:Georgia,serif;color:#f3e6cc;line-height:1.6">' +
      '<p style="font:800 12px Arial,sans-serif;letter-spacing:.24em;color:#eda644;margin:0">DEMO OF THE MONTH · ' + esc_(month.toUpperCase()) + '</p>' +
      '<p style="font:800 28px Arial,sans-serif;line-height:1.1;margin:14px 0 6px">' + esc_(best.title) + '</p>' +
      '<p style="font:500 18px Arial,sans-serif;margin:0 0 16px;color:#ea6356">' + esc_(best.artist) + '</p>' +
      '<p style="font-size:22px;color:#eda644;margin:0">' + stars_(best.avg) + ' <span style="font-size:15px;color:#c9b79a">' +
        best.avg.toFixed(1) + ' IZIKI fit · ' + best.count + ' ratings</span></p>' +
      '<p style="margin-top:20px"><a href="' + esc_(best.url) + '" style="color:#eda644;font:800 16px Arial,sans-serif">▶ Listen</a>' +
      ' &nbsp;·&nbsp; <a href="mailto:' + esc_(best.email) + '" style="color:#f3e6cc">Email the artist</a>' +
      ' &nbsp;·&nbsp; <a href="' + esc_(room) + '" style="color:#f3e6cc">Open the Listening Room</a></p></div>'
  });
}

/** Best rated track among demos received in [start, end). Tracks rated by the whole team come first. */
function bestOf_(start, end) {
  var demos = {};
  rows_(sheet_()).forEach(function (r) {
    var t = new Date(r['Received']);
    if (r['ID'] && t >= start && t < end) demos[r['ID']] = r;
  });
  var agg = {};
  rows_(ratingsSheet_()).forEach(function (r) {
    if (!demos[r['Demo ID']]) return;
    var k = r['Demo ID'] + '#' + r['Track #'];
    (agg[k] = agg[k] || { id: r['Demo ID'], track: Number(r['Track #']), sum: 0, count: 0 });
    agg[k].sum += Number(r['IZIKI fit']); agg[k].count++;
  });
  var list = Object.keys(agg).map(function (k) {
    var a = agg[k], d = demos[a.id], tr = tracks_(d)[a.track - 1] || {};
    return { id: a.id, artist: d['Artist'], email: d['Email'], title: tr.title || d['Tracks'], url: tr.url || '',
             avg: a.sum / a.count, count: a.count, full: a.count >= CONFIG.TEAM.length, received: new Date(d['Received']) };
  });
  list.sort(function (a, b) {
    return (b.full - a.full) || (b.avg - a.avg) || (b.count - a.count) || (a.received - b.received);
  });
  return list[0] || null;
}

// ---------- helpers ----------
function validate_(d) {
  if (!s_(d.artist)) return 'Please add your artist name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s_(d.email))) return 'Please check your email address.';
  if (!s_(d.tracks)) return 'Please add your track title(s).';
  var links = s_(d.link).split('\n');
  for (var i = 0; i < links.length; i++) {
    if (!/https?:\/\/\S+$/i.test(links[i].trim())) return 'Please add a valid listening link for every track (starting with https://).';
  }
  if (!s_(d.style)) return 'Please choose Afro house or Afro tech house for every track.';
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

function ss_() {
  return CONFIG.SHEET_ID ? SpreadsheetApp.openById(CONFIG.SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function iso_(v) { return v instanceof Date ? v.toISOString() : String(v || ''); }

function stars_(n) { var r = Math.floor(n + 0.001); return '★★★★★'.slice(0, r) + '☆☆☆☆☆'.slice(0, 5 - r); }

function sheet_() {
  var ss = ss_();
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

function ratingsSheet_() { return tab_(CONFIG.RATINGS_SHEET, RATING_HEADERS); }
function picksSheet_() { return tab_(CONFIG.PICKS_SHEET, PICK_HEADERS); }

function tab_(name, headers) {
  var ss = ss_();
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#2b2522').setFontColor('#eda644');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Sheet rows as objects keyed by header name. */
function rows_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var v = sh.getRange(1, 1, last, sh.getLastColumn()).getValues(), h = v[0];
  return v.slice(1).map(function (row) {
    var o = {}; h.forEach(function (k, i) { o[k] = row[i]; }); return o;
  });
}

/** Split a demo row into tracks: [{n, title, url, style, bpm}] */
function tracks_(r) {
  var titles = String(r['Tracks'] || '').split(' | ');
  var links = String(r['Listen link'] || '').split('\n');
  var styles = String(r['Style'] || '').split(' / ');
  var bpms = String(r['BPM'] || '').split(' / ');
  return titles.map(function (t, i) {
    var url = ((links[i] || links[0] || '').match(/https?:\/\/\S+/) || [''])[0];
    return { n: i + 1, title: t, url: url,
             style: styles[i] || styles[0] || '', bpm: (bpms[i] || '').replace('–', '') };
  });
}

function findDemo_(id) {
  var list = rows_(sheet_());
  for (var i = 0; i < list.length; i++) {
    if (list[i]['ID'] === id) return { row: list[i], rowNum: i + 2, tracks: tracks_(list[i]) };
  }
  return null;
}

/** Average IZIKI fit across all ratings of a demo, written to the Demos tab. */
function updateDemoScore_(id) {
  var sum = 0, n = 0;
  rows_(ratingsSheet_()).forEach(function (r) {
    if (r['Demo ID'] === id) { sum += Number(r['IZIKI fit']); n++; }
  });
  var demo = findDemo_(id);
  if (demo) sheet_().getRange(demo.rowNum, HEADERS.indexOf('IZIKI fit') + 1).setValue(n ? Math.round(sum / n * 10) / 10 : '');
}

function roomKey_() {
  var p = PropertiesService.getScriptProperties(), k = p.getProperty('ROOM_KEY');
  if (!k) { k = Utilities.getUuid().replace(/-/g, ''); p.setProperty('ROOM_KEY', k); }
  return k;
}

function checkKey_(key) { if (key !== roomKey_()) throw new Error('Not allowed'); }

function baseUrl_() { return CONFIG.WEB_APP_URL || ScriptApp.getService().getUrl(); }

function roomLinks_() {
  var base = baseUrl_();
  return CONFIG.TEAM.map(function (who) {
    return { who: who, url: base + '?view=room&key=' + roomKey_() + '&who=' + encodeURIComponent(who) };
  });
}

function esc_(v) {
  return String(v || '').replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function notifyLabel_(d, id) {
  if (!CONFIG.NOTIFY_EMAIL || CONFIG.NOTIFY_EMAIL.indexOf('example.com') > -1) return;
  var url = ss_().getUrl();
  var rows = [
    ['Artist', d.artist], ['Email', d.email], ['From', d.location], ['Beatport', d.beatport],
    ['SoundCloud', d.soundcloud], ['Spotify', d.spotify], ['Instagram', d.instagram],
    ['Website', d.site],
    ['Tracks', d.tracks], ['Style', d.style], ['BPM', d.bpm], ['Type', d.type],
    ['Previous', d.previous], ['Note', d.note]
  ].filter(function (r) { return r[1]; }).map(function (r) {
    return '<tr><td style="padding:4px 14px 4px 0;color:#9a8a72;vertical-align:top">' + r[0] +
           '</td><td style="padding:4px 0">' + esc_(r[1]) + '</td></tr>';
  }).join('');
  var room = '';
  try { room = roomLinks_().map(function (l) {
    return '<a href="' + esc_(l.url) + '">Rate as ' + esc_(l.who) + '</a>'; }).join(' &nbsp;·&nbsp; '); } catch (_) {}

  MailApp.sendEmail({
    to: CONFIG.NOTIFY_EMAIL,
    replyTo: s_(d.email),
    subject: 'New demo · ' + s_(d.artist) + ' — ' + s_(d.tracks),
    htmlBody:
      '<div style="font-family:Georgia,serif;color:#2b2522">' +
      '<p style="font:800 12px Arial,sans-serif;letter-spacing:.2em;color:#ea6356">NEW DEMO · ' + id + '</p>' +
      listenLinks_(d) +
      (d.download ? '<p><a href="' + esc_(d.download) + '">Download (WAV)</a></p>' : '') +
      '<table style="font-size:14px">' + rows + '</table>' +
      '<p style="margin-top:18px">' + (room ? room + ' &nbsp;·&nbsp; ' : '') +
      '<a href="' + url + '">Open the demo sheet</a></p></div>'
  });
}

function listenLinks_(d) {
  var titles = String(d.tracks || '').split(' | ');
  return String(d.link || '').split('\n').map(function (line, i) {
    var url = (line.match(/https?:\/\/\S+/) || [''])[0];
    return '<p style="margin:4px 0"><a href="' + esc_(url) + '" style="font:800 16px Arial,sans-serif;color:#2b2522">▶ ' +
           esc_(titles[i] || 'Listen') + '</a></p>';
  }).join('');
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
/** Run once: builds all tabs and the monthly trigger. */
function setup() {
  setupSheet();
  ratingsSheet_();
  picksSheet_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'monthlyPick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('monthlyPick').timeBased().onMonthDay(1).atHour(10)
    .inTimezone(CONFIG.TIMEZONE).create();
  roomKey_();
}

/** Run after deploying the web app: emails the team their private Listening Room links. */
function sendRoomLinks() {
  var links = roomLinks_();
  links.forEach(function (l) { Logger.log(l.who + ': ' + l.url); });
  MailApp.sendEmail({
    to: CONFIG.NOTIFY_EMAIL,
    subject: 'IZIKI · Your Listening Room links',
    htmlBody: '<p>Bookmark your own link. Do not share them outside the team.</p>' +
      links.map(function (l) { return '<p><b>' + esc_(l.who) + ':</b> <a href="' + esc_(l.url) + '">' + esc_(l.url) + '</a></p>'; }).join('')
  });
}

function setupSheet() {
  var ss = ss_();
  var sh = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setBackground('#2b2522').setFontColor('#eda644');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(4);

  var n = sh.getMaxRows() - 1;
  sh.getRange(2, 2, n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build());
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
