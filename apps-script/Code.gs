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
  WEB_APP_URL: '',                      // published web app URL (…/exec)
  ROOM_URL: 'https://izikiglobal.github.io/demos/room.html', // Listening Room page (empty = serve it from Apps Script)
  NOTIFY_EMAIL: 'izikiteam@gmail.com',  // new-demo alerts + monthly pick (comma-separate for several)
  REPLY_TO: 'izikiteam@gmail.com',      // reply-to on the artist confirmation
  TEAM: ['Danielle', 'Mikkas'],         // listeners in the Listening Room
  TEAM_EMAILS: {},                      // personal alert address per listener, e.g. { Danielle: '…', Mikkas: '…' }
                                        // (filled in the live script only; keep personal emails out of GitHub)
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
  'Rights confirmed', 'No AI confirmed', 'Consent', 'Internal notes', 'ID', 'Bio'
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
  var d;
  try { d = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (x) { return json_({ ok: false, error: 'Bad request.' }); }
  if (d.action) return json_(roomApi_(d)); // Listening Room + Press Kits panel calls
  if (d.catalogue) return json_(kitCatalogue_(d.k)); // release list for the press-kit form
  if (d.kit) { try { return json_(submitKit_(d)); } catch (x) { return json_({ ok: false, error: String(x && x.message || x) }); } } // artist press-kit form

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);

    if (d.website) return json_({ ok: true }); // honeypot: pretend success for bots

    var err = validate_(d);
    if (err) return json_({ ok: false, error: err });
    d.link = fixLinks_(d.link); // SoundCloud short links -> full links the player can open

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
      d.owned ? 'Yes' : 'No', d.noAI ? 'Yes' : 'No', d.consent ? 'Yes' : 'No', '', id, s_(d.bio)
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

// ---------- Listening Room API (called from room.html on GitHub Pages, or Room.html) ----------
var ROOM_FNS = { roomData: roomData, rateTrack: rateTrack, setStatus: setStatus, saveNotes: saveNotes, kitData: kitData };

function roomApi_(d) {
  var fn = ROOM_FNS[d.action];
  if (!fn) return { ok: false, error: 'Unknown action' };
  try {
    return { ok: true, result: fn.apply(null, Array.isArray(d.args) ? d.args : []) };
  } catch (x) {
    return { ok: false, error: x && x.message ? x.message : String(x) };
  }
}

function roomData(key) {
  checkKey_(key);
  upgradeLinks_(sheet_());
  var demos = rows_(sheet_()).map(function (r) {
    return {
      id: r['ID'], received: iso_(r['Received']), status: r['Status'] || 'New',
      artist: r['Artist'], realName: r['Real name'], bio: r['Bio'] || '', location: r['Location'], email: r['Email'],
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
  var top = topOf_(start, end, 5);
  var room = roomLinks_()[0].url;

  if (!top.length) {
    MailApp.sendEmail({ to: teamRecipients_(), subject: 'IZIKI · Top 5 of the month · ' + month,
      htmlBody: '<p>No rated demos for ' + month + '.</p>' });
    return;
  }
  var ps = picksSheet_();
  top.forEach(function (t, i) {
    ps.appendRow([month + ' · #' + (i + 1), t.id, t.artist, t.title, Math.round(t.avg * 10) / 10, t.count, t.url, t.email]);
  });

  var medals = ['1ST', '2ND', '3RD', '4TH', '5TH'];
  var items = top.map(function (t, i) {
    return '<div style="border-top:1px solid #4a413a;padding:16px 0">' +
      '<p style="font:800 11px Arial,sans-serif;letter-spacing:.24em;color:#eda644;margin:0">' + medals[i] + '</p>' +
      '<p style="font:800 ' + (i ? 20 : 26) + 'px Arial,sans-serif;line-height:1.15;margin:6px 0 2px">' + esc_(t.title) + '</p>' +
      '<p style="font:500 16px Arial,sans-serif;margin:0 0 8px;color:#ea6356">' + esc_(t.artist) + '</p>' +
      '<p style="font-size:18px;color:#eda644;margin:0">' + stars_(t.avg) + ' <span style="font-size:14px;color:#c9b79a">' +
        t.avg.toFixed(1) + ' IZIKI fit · ' + t.count + ' of ' + CONFIG.TEAM.length + ' rated</span></p>' +
      '<p style="margin:10px 0 0"><a href="' + esc_(t.url) + '" style="color:#eda644;font:800 15px Arial,sans-serif">▶ Listen</a>' +
      ' &nbsp;·&nbsp; <a href="mailto:' + esc_(t.email) + '" style="color:#f3e6cc">Email the artist</a></p></div>';
  }).join('');

  MailApp.sendEmail({
    to: teamRecipients_(),
    subject: 'IZIKI · Top 5 of the month · ' + month + ' — ' + top[0].artist,
    htmlBody:
      '<div style="background:#2b2522;padding:32px 26px;font-family:Georgia,serif;color:#f3e6cc;line-height:1.6">' +
      '<p style="font:800 12px Arial,sans-serif;letter-spacing:.24em;color:#eda644;margin:0 0 14px">TOP 5 OF THE MONTH · ' + esc_(month.toUpperCase()) + '</p>' +
      items +
      '<p style="margin-top:20px"><a href="' + esc_(room) + '" style="color:#f3e6cc;font:800 15px Arial,sans-serif">Open the Listening Room to decide →</a></p></div>'
  });
}

/** Best rated track (kept for compatibility). */
function bestOf_(start, end) { return topOf_(start, end, 1)[0] || null; }

/** Top-rated tracks among demos received in [start, end). Tracks rated by the whole team come first. */
function topOf_(start, end, n) {
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
  return list.slice(0, n || 1);
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
  if (!s_(d.style)) return 'Please choose a style (Afro house, Afrotech, Tribal or 3 Step) for every track.';
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
  else if (sh.getLastColumn() < HEADERS.length) { // new columns added later (e.g. Bio)
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  }
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

// ---------- SoundCloud links ----------
// Artists often paste short share links (on.soundcloud.com/…). The SoundCloud player can't open those,
// so we follow the redirect once and keep the full track link (private token included).
function resolveSoundCloud_(u) {
  u = String(u || '').trim();
  for (var hop = 0; hop < 4 && /^https?:\/\/(on\.soundcloud\.com|soundcloud\.app\.goo\.gl)\//i.test(u); hop++) {
    try {
      var r = UrlFetchApp.fetch(u, { followRedirects: false, muteHttpExceptions: true });
      var h = r.getHeaders(), loc = h.Location || h.location;
      if (!loc) break;
      u = String(loc);
    } catch (e) { break; }
  }
  if (/^https?:\/\/(m\.|www\.)?soundcloud\.com\//i.test(u)) {
    u = u.replace(/^https?:\/\/(m\.|www\.)?soundcloud\.com/i, 'https://soundcloud.com').split('?')[0].split('#')[0];
  }
  return u;
}

function fixLinks_(text) {
  return String(text || '').replace(/https?:\/\/[^\s|]+/g, function (u) {
    return /soundcloud\.(com|app\.goo\.gl)\//i.test(u) ? resolveSoundCloud_(u) : u;
  });
}

/** Rewrites short SoundCloud links already in the sheet (runs when the Listening Room loads; cheap after the first time). */
function upgradeLinks_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return;
  var col = HEADERS.indexOf('Listen link') + 1;
  var rng = sh.getRange(2, col, last - 1, 1), vals = rng.getValues(), changed = false;
  for (var i = 0; i < vals.length; i++) {
    var v = String(vals[i][0] || '');
    if (/on\.soundcloud\.com|soundcloud\.app\.goo\.gl|[?&](si|utm_source)=/i.test(v)) {
      var nv = fixLinks_(v);
      if (nv !== v) { vals[i][0] = nv; changed = true; }
    }
  }
  if (changed) rng.setValues(vals);
}

/** Run once from the editor to approve the new "connect to external service" permission. */
function authorizeLinkFix() {
  Logger.log(resolveSoundCloud_('https://on.soundcloud.com/QKdQswTHjsgUaLSE99'));
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
    var q = 'key=' + roomKey_() + '&who=' + encodeURIComponent(who);
    return { who: who, url: CONFIG.ROOM_URL ? CONFIG.ROOM_URL + '?' + q : base + '?view=room&' + q };
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
    ['Artist', d.artist], ['Bio', d.bio], ['Email', d.email], ['From', d.location], ['Beatport', d.beatport],
    ['SoundCloud', d.soundcloud], ['Spotify', d.spotify], ['Instagram', d.instagram],
    ['Website', d.site],
    ['Tracks', d.tracks], ['Style', d.style], ['BPM', d.bpm], ['Type', d.type],
    ['Previous', d.previous], ['Note', d.note]
  ].filter(function (r) { return r[1]; }).map(function (r) {
    return '<tr><td style="padding:4px 14px 4px 0;color:#9a8a72;vertical-align:top">' + r[0] +
           '</td><td style="padding:4px 0">' + esc_(r[1]) + '</td></tr>';
  }).join('');
  var subject = 'New demo · ' + s_(d.artist) + ' — ' + s_(d.tracks);
  function body(footer) {
    return '<div style="font-family:Georgia,serif;color:#2b2522">' +
      '<p style="font:800 12px Arial,sans-serif;letter-spacing:.2em;color:#ea6356">NEW DEMO · ' + id + '</p>' +
      listenLinks_(d) +
      (d.download ? '<p><a href="' + esc_(d.download) + '">Download (WAV)</a></p>' : '') +
      '<table style="font-size:14px">' + rows + '</table>' +
      '<p style="margin-top:18px">' + footer + '</p></div>';
  }

  // Team inbox copy (archive; replying goes to the artist)
  MailApp.sendEmail({ to: CONFIG.NOTIFY_EMAIL, replyTo: s_(d.email), subject: subject,
    htmlBody: body('<a href="' + url + '">Open the demo sheet</a>') });

  // One personal email per listener, with only their own Listening Room link
  var links = [];
  try { links = roomLinks_(); } catch (_) {}
  links.forEach(function (l) {
    var to = (CONFIG.TEAM_EMAILS || {})[l.who];
    if (!to) return;
    MailApp.sendEmail({ to: to, replyTo: s_(d.email), name: CONFIG.LABEL_NAME, subject: subject,
      htmlBody: body('Hi ' + esc_(l.who) + ' — <a href="' + esc_(l.url) +
        '" style="font:800 15px Arial,sans-serif;color:#ea6356">Rate it in your Listening Room →</a>') });
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
  roomLinks_().forEach(function (l) {
    Logger.log(l.who + ': ' + l.url);
    var to = (CONFIG.TEAM_EMAILS || {})[l.who] || CONFIG.NOTIFY_EMAIL;
    MailApp.sendEmail({
      to: to,
      name: CONFIG.LABEL_NAME,
      subject: 'IZIKI · Your Listening Room link',
      htmlBody: '<div style="font-family:Georgia,serif;color:#2b2522">' +
        '<p>Hi ' + esc_(l.who) + ',</p>' +
        '<p>This is your personal IZIKI Listening Room. Bookmark it, and please don\'t share it.</p>' +
        '<p><a href="' + esc_(l.url) + '" style="font:800 16px Arial,sans-serif;color:#ea6356">Open my Listening Room →</a></p>' +
        '<p style="color:#9a8a72;font-size:13px">Every new demo email also has this link at the bottom.</p></div>'
    });
  });
}

function teamRecipients_() {
  var list = [CONFIG.NOTIFY_EMAIL];
  Object.keys(CONFIG.TEAM_EMAILS || {}).forEach(function (k) { if (CONFIG.TEAM_EMAILS[k]) list.push(CONFIG.TEAM_EMAILS[k]); });
  return list.join(',');
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

// =====================================================================
// PRESS KITS: artists send links to their own files (Drive/Dropbox…);
// we keep only the links, one row per artist (matched by email).
// =====================================================================
var KIT_SHEET = 'Press kits';
var KIT_HEADERS = ['Updated', 'Artist', 'Real name', 'Email', 'City', 'Profile photo', 'Press kit folder',
  'Photos', 'Videos', 'Bio', 'Bio link', 'Instagram', 'SoundCloud', 'Spotify', 'Beatport', 'Website', 'IZIKI releases', 'First sent', 'ID'];
var KIT_PAGES = 'https://izikiglobal.github.io/demos/';
var CATALOGUE_ID = '13VN8Z8KU21p81P8jVKSaVVezWTdGig_pHZHMysQER48'; // "IZIKI Releases Catalogue" sheet (first tab)

/** Releases from the IZIKI catalogue sheet, for the checklist on the press-kit form. */
function kitCatalogue_(k) {
  if (k !== kitKey_()) return { ok: false, error: 'Not allowed' };
  var v = SpreadsheetApp.openById(CATALOGUE_ID).getSheets()[0].getDataRange().getDisplayValues();
  var h = v[0].map(function (x) { return String(x).trim().toLowerCase(); });
  var col = function (name) { return h.indexOf(name); };
  var c = { title: col('title'), cat: col('cat. no'), artist: col('artist - original'), track: col('track'), remix: col('artist - remix'), date: col('release date') };
  var list = v.slice(1).map(function (r) {
    var g = function (i) { return i < 0 ? '' : String(r[i] || '').trim(); };
    var y = (g(c.date).match(/(?:^|\D)((?:19|20)\d{2})(?!\d)/) || ['', ''])[1];
    return { cat: g(c.cat).replace(/O(?=\d+$)/i, '0'), release: g(c.title).replace(/\s+/g, ' '), track: g(c.track), artist: g(c.artist), remix: g(c.remix), year: y };
  }).filter(function (x) { return x.track; });
  return { ok: true, result: list };
}

function kitSheet_() { return tab_(KIT_SHEET, KIT_HEADERS); }

function kitKey_() {
  var p = PropertiesService.getScriptProperties(), k = p.getProperty('KIT_KEY');
  if (!k) { k = Utilities.getUuid().replace(/-/g, '').slice(0, 16); p.setProperty('KIT_KEY', k); }
  return k;
}

function isUrl_(v) { return /^https?:\/\/\S+\.\S+/i.test(String(v || '').trim()); }

function submitKit_(d) {
  if (d.website) return { ok: true };                       // honeypot
  if (d.k !== kitKey_()) return { ok: false, error: 'This form link is not valid. Ask IZIKI for a new one.' };
  var email = s_(d.email).toLowerCase();
  if (!s_(d.artist)) return { ok: false, error: 'Please add your artist name.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Please add a valid email.' };
  if (!d.folder && !(d.photos && d.videos && (s_(d.bio) || d.bioLink))) return { ok: false, error: 'Please share your press kit folder (Option A), or your photos, videos and bio (Option B).' };
  var links = ['folder', 'photos', 'videos', 'bioLink', 'soundcloud', 'spotify', 'beatport', 'site'];
  for (var i = 0; i < links.length; i++) {
    if (d[links[i]] && !isUrl_(d[links[i]])) return { ok: false, error: 'One of the links is not a full link (it should start with https://).' };
  }
  if (!s_(d.instagram)) return { ok: false, error: 'Please add your Instagram.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = kitSheet_(), now = new Date(), row = 0, id = '', first = now;
    var last = sh.getLastRow();
    if (last > 1) {
      var vals = sh.getRange(2, 1, last - 1, KIT_HEADERS.length).getValues();
      var ei = KIT_HEADERS.indexOf('Email');
      for (var r = 0; r < vals.length; r++) {
        if (String(vals[r][ei]).toLowerCase() === email) {
          row = r + 2; id = vals[r][KIT_HEADERS.indexOf('ID')]; first = vals[r][KIT_HEADERS.indexOf('First sent')] || now; break;
        }
      }
    }
    var oldPhoto = row ? String(sh.getRange(row, KIT_HEADERS.indexOf('Profile photo') + 1).getValue()) : '';
    if (d.photoData) d.photo = saveKitPhoto_(d.photoData, s_(d.artist), oldPhoto);
    else if (oldPhoto) d.photo = oldPhoto;
    else return { ok: false, error: 'Please choose a profile photo.' };
    if (!id) id = 'KIT-' + Utilities.formatDate(now, 'Etc/UTC', 'yyMMdd') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    var data = [now, s_(d.artist), s_(d.realName), email, s_(d.city), s_(d.photo), s_(d.folder),
      s_(d.photos), s_(d.videos), (function (v) { return /^[=+\-@]/.test(v) ? "'" + v : v; })(String(d.bio || '').trim().slice(0, 3000)), s_(d.bioLink), s_(d.instagram), s_(d.soundcloud), s_(d.spotify), s_(d.beatport), s_(d.site), (function (v) { return /^[=+\-@]/.test(v) ? "'" + v : v; })(String(d.releases || '').trim().slice(0, 2000)), first, id];
    if (row) sh.getRange(row, 1, 1, data.length).setValues([data]); else sh.appendRow(data);
    notifyKit_(d, !!row);
    return { ok: true, updated: !!row };
  } finally { lock.releaseLock(); }
}

/** Profile photos: one small JPEG per artist in the IZIKI Drive (folder below). */
var KIT_PHOTO_FOLDER = 'IZIKI Press kits – profile photos';
var KIT_PHOTO_MAX = 32 * 1024; // bytes; the form keeps photos under 30 KB

function kitPhotoFolder_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('KIT_PHOTO_FOLDER_ID');
  if (id) { try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  var folder = DriveApp.createFolder(KIT_PHOTO_FOLDER);
  props.setProperty('KIT_PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

function saveKitPhoto_(dataUrl, artist, oldUrl) {
  var m = String(dataUrl).match(/^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/);
  if (!m) throw new Error('The profile photo could not be read. Please choose it again.');
  var bytes = Utilities.base64Decode(m[1]);
  if (bytes.length > KIT_PHOTO_MAX) throw new Error('The profile photo is too big. Please choose another one.');
  if ((bytes[0] & 255) !== 0xFF || (bytes[1] & 255) !== 0xD8) throw new Error('The profile photo could not be read. Please choose it again.');
  var folder = kitPhotoFolder_();
  var name = (artist || 'artist').replace(/[^\w\- .]+/g, '').trim().slice(0, 60) || 'artist';
  var file = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', name + '.jpg'));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var old = String(oldUrl || '').match(/\/file\/d\/([\w-]{20,})/);
  if (old) { try { var of = DriveApp.getFileById(old[1]); if (of.getParents().hasNext() && of.getParents().next().getId() === folder.getId()) of.setTrashed(true); } catch (e) {} }
  return 'https://drive.google.com/file/d/' + file.getId() + '/view';
}

/** Run once from the editor to approve Drive access and create the photo folder. */
function setupKitPhotos() {
  var f = kitPhotoFolder_();
  Logger.log('Photo folder: ' + f.getUrl());
  return f.getUrl();
}

function notifyKit_(d, updated) {
  var panel = KIT_PAGES + 'kits.html?key=' + roomKey_();
  var rows = [['Artist', d.artist], ['Real name', d.realName], ['Email', d.email], ['City', d.city],
    ['Profile photo', d.photo], ['Press kit folder', d.folder], ['Photos', d.photos], ['Videos', d.videos],
    ['Bio', d.bio], ['Bio link', d.bioLink], ['Instagram', d.instagram], ['SoundCloud', d.soundcloud],
    ['Spotify', d.spotify], ['Beatport', d.beatport], ['Website', d.site], ['IZIKI releases', d.releases]]
    .filter(function (r) { return r[1]; }).map(function (r) {
      var v = isUrl_(r[1]) ? '<a href="' + esc_(r[1]) + '" style="color:#eda644">' + esc_(r[1]) + '</a>' : '<span style="white-space:pre-line">' + esc_(r[1]) + '</span>';
      return '<tr><td style="padding:4px 14px 4px 0;color:#9a8a72;vertical-align:top">' + r[0] + '</td><td style="padding:4px 0">' + v + '</td></tr>';
    }).join('');
  MailApp.sendEmail({
    to: CONFIG.NOTIFY_EMAIL, name: CONFIG.LABEL_NAME, replyTo: s_(d.email),
    subject: 'Press kit ' + (updated ? 'updated' : 'received') + ' · ' + s_(d.artist),
    htmlBody: '<div style="background:#2b2522;padding:28px 24px;font-family:Georgia,serif;color:#f3e6cc;line-height:1.55">' +
      '<p style="font:800 12px Arial,sans-serif;letter-spacing:.24em;color:#eda644;margin:0 0 12px">PRESS KIT ' + (updated ? 'UPDATED' : 'RECEIVED') + '</p>' +
      '<p style="font:800 26px Arial,sans-serif;margin:0 0 16px">' + esc_(d.artist) + '</p>' +
      '<table style="font:14px Arial,sans-serif;color:#f3e6cc;border-collapse:collapse">' + rows + '</table>' +
      '<p style="margin-top:22px"><a href="' + esc_(panel) + '" style="color:#f3e6cc;font:800 15px Arial,sans-serif">Open the Press Kits panel →</a></p></div>'
  });
}

/** Panel data (team key). */
function kitData(key) {
  checkKey_(key);
  var sh = kitSheet_(), last = sh.getLastRow();
  if (last < 2) return JSON.stringify([]);
  var v = sh.getRange(1, 1, last, sh.getLastColumn()).getValues(), h = v[0];
  var out = v.slice(1).map(function (row) {
    var o = {}; h.forEach(function (k, i) { o[k] = row[i] instanceof Date ? row[i].toISOString() : row[i]; }); return o;
  });
  return JSON.stringify(out);
}

/** Run once from the editor: creates the tab and emails izikiteam the artist form link + the panel link. */
function kitLinks() {
  kitSheet_();
  var form = KIT_PAGES + 'kit.html?k=' + kitKey_();
  var panel = KIT_PAGES + 'kits.html?key=' + roomKey_();
  Logger.log('Artist form: ' + form + '\nPanel: ' + panel);
  MailApp.sendEmail({
    to: CONFIG.NOTIFY_EMAIL, name: CONFIG.LABEL_NAME, subject: 'IZIKI · Press kit links',
    htmlBody: '<div style="background:#2b2522;padding:28px 24px;font-family:Georgia,serif;color:#f3e6cc;line-height:1.6">' +
      '<p style="font:800 12px Arial,sans-serif;letter-spacing:.24em;color:#eda644;margin:0 0 14px">PRESS KITS</p>' +
      '<p><b>Send this to IZIKI artists</b> (private form, they paste links to their own files):<br><a href="' + form + '" style="color:#eda644">' + form + '</a></p>' +
      '<p><b>Your panel</b> (keep it in the team, bookmark it):<br><a href="' + panel + '" style="color:#eda644">' + panel + '</a></p></div>'
  });
}
