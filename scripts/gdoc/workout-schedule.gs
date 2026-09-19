/**
 * Iron Hub -> "Workout Schedule" Google Doc relay.
 *
 * Iron Hub is a single static HTML file with no backend, so it cannot hold Google credentials
 * and cannot call the Docs API: the OAuth token exchange needs a client secret, and the repo is
 * public. This script is the other half. It lives INSIDE the doc (Extensions > Apps Script), so
 * it already has permission to edit it, and the app only ever POSTs a plain description of a
 * week -- no credentials, no Google libraries, no build step.
 *
 * It is not loaded by the app and is not part of the single-file constraint.
 *
 * ---------------------------------------------------------------------------------------
 * ONE-TIME SETUP
 *
 * 1. Open the Workout Schedule doc > Extensions > Apps Script. Paste this file over Code.gs.
 *
 * 2. Project Settings > Script Properties > Add script property:
 *      IRONHUB_SECRET = <a long random string you invent>
 *    Without it every request is refused, so the web app is useless to anyone who finds the URL.
 *
 * 3. Deploy > New deployment > type "Web app":
 *      Execute as:      Me
 *      Who has access:  Anyone
 *    "Anyone" is required because the app is a page in a browser with no Google sign-in. The
 *    secret above is what actually guards it, and this script can only ever rewrite week blocks
 *    in this one document -- it cannot read your Drive, send mail, or touch anything else.
 *
 * 4. Copy the deployment's Web app URL (ends in /exec) into Iron Hub:
 *      Settings > Workout Schedule Doc > paste URL + the same secret > Test doc.
 *    The URL and secret are stored per device and are never synced, so do this on each device.
 *
 * 5. TRY IT ON A COPY FIRST. File > Make a copy, run the setup there, confirm the block lands
 *    at the top and looks right, then point it at the real doc.
 *
 * Re-deploy note: editing this file does NOT change what the /exec URL runs. Deploy > Manage
 * deployments > edit > Version: New version. Otherwise the old code keeps answering.
 * ---------------------------------------------------------------------------------------
 *
 * WHAT IT DOES
 *
 * One POST carries one or more weeks, oldest first:
 *
 *   { "secret": "...", "weeks": [ { "label": "Week of Sep 6-12",
 *                                   "days": [ {"text":"Sunday, Sep 6: CHEST + TRICEPS [VANGUARD]",
 *                                              "plainFrom": -1, "status":"done"}, ... ] } ] }
 *
 *   plainFrom  index at which the line stops being bold (-1 = the whole line is bold). It exists
 *              because a rest line in this doc is bold up to the colon and plain after it.
 *   status     done -> green highlight, missed -> red, pending -> no highlight.
 *
 * A week whose label is already in the doc is REWRITTEN IN PLACE; a new label is inserted at the
 * top. That makes the whole thing idempotent: the app re-sends the current week every time
 * something about it changes, any device may send it, and a repeat is a no-op. Weeks nobody
 * sends are never touched, so the hand-written history from January stays exactly as it is.
 */

var ATTR = DocumentApp.Attribute;

var FONT = 'Verdana';
var SIZE_HEADER = 14;
var SIZE_DAY = 11;
var GREEN = '#00ff00';   // the highlight colours already in the doc -- matched, not invented
var RED = '#ff0000';
var SEPARATOR = '-----';
var LABEL_PREFIX = 'Week of ';

function doPost(e) {
  try {
    var want = PropertiesService.getScriptProperties().getProperty('IRONHUB_SECRET');
    if (!want) return reply({ ok: false, error: 'the IRONHUB_SECRET script property is not set' });

    var req = {};
    try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
    catch (err) { return reply({ ok: false, error: 'body was not JSON' }); }

    if (String(req.secret || '') !== String(want)) return reply({ ok: false, error: 'bad secret' });

    // A ping proves the URL, the secret and the deployment all work without editing anything.
    if (req.ping) return reply({ ok: true, ping: true, doc: DocumentApp.getActiveDocument().getName() });

    var weeks = req.weeks;
    if (!weeks || !weeks.length) return reply({ ok: false, error: 'no weeks in the request' });

    var body = DocumentApp.getActiveDocument().getBody();
    var done = [];
    for (var i = 0; i < weeks.length; i++) {
      var wk = weeks[i];
      if (!wk || !wk.label || !wk.days || !wk.days.length) continue;
      done.push(wk.label + ' (' + writeWeek(body, wk) + ')');
    }
    if (!done.length) return reply({ ok: false, error: 'every week in the request was malformed' });
    return reply({ ok: true, weeks: done });
  } catch (err) {
    // Never let this 500. The app reports whatever comes back, and "Exception: ..." on screen is
    // worth far more than a blank failure it has to guess at.
    return reply({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/** GET exists only so opening the /exec URL in a browser says something useful. */
function doGet() {
  return reply({ ok: true, note: 'Iron Hub schedule relay is deployed. It only answers POSTs.' });
}

function reply(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Insert the new block FIRST, then remove the old one. The other order can empty the body when
 * the doc holds a single week, and Docs refuses to remove the last paragraph in a section.
 */
function writeWeek(body, week) {
  var idx = findWeek(body, week.label);
  var action = idx < 0 ? 'inserted' : 'updated';
  var at = idx < 0 ? 0 : idx;
  var oldLen = idx < 0 ? 0 : blockLength(body, idx);
  var added = insertBlock(body, at, week);
  for (var i = at + added + oldLen - 1; i >= at + added; i--) body.removeChild(body.getChild(i));
  return action;
}

function findWeek(body, label) {
  var n = body.getNumChildren();
  for (var i = 0; i < n; i++) {
    var c = body.getChild(i);
    if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    if (c.asParagraph().getText().trim() === label) return i;
  }
  return -1;
}

/** How many children belong to the week starting at idx: up to, but not including, the next header. */
function blockLength(body, idx) {
  var n = body.getNumChildren();
  for (var i = idx + 1; i < n; i++) {
    var c = body.getChild(i);
    if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    if (c.asParagraph().getText().trim().indexOf(LABEL_PREFIX) === 0) return i - idx;
  }
  return n - idx;
}

/**
 * header / blank / (day / blank) x7 / ----- / blank  -- the shape every hand-written week in
 * this doc already has. Returns the number of paragraphs added.
 */
function insertBlock(body, at, week) {
  var i = at;
  header(body.insertParagraph(i++, week.label));
  blank(body.insertParagraph(i++, ''));
  for (var d = 0; d < week.days.length; d++) {
    dayLine(body.insertParagraph(i++, String(week.days[d].text || '')), week.days[d]);
    blank(body.insertParagraph(i++, ''));
  }
  plain(body.insertParagraph(i++, SEPARATOR));
  blank(body.insertParagraph(i++, ''));
  return i - at;
}

function base(size, bold, underline) {
  var a = {};
  a[ATTR.FONT_FAMILY] = FONT;
  a[ATTR.FONT_SIZE] = size;
  a[ATTR.BOLD] = !!bold;
  a[ATTR.ITALIC] = false;
  a[ATTR.UNDERLINE] = !!underline;
  a[ATTR.FOREGROUND_COLOR] = '#000000';
  a[ATTR.BACKGROUND_COLOR] = null;
  return a;
}

/** setAttributes rather than editAsText(): it is the only one that styles an EMPTY paragraph. */
function shape(p, attrs, align) {
  p.setHeading(DocumentApp.ParagraphHeading.NORMAL);
  p.setAlignment(align);
  p.setLineSpacing(1.5);
  p.setAttributes(attrs);
  return p;
}

function header(p) {
  shape(p, base(SIZE_HEADER, true, true), DocumentApp.HorizontalAlignment.CENTER);
}

function blank(p) {
  shape(p, base(SIZE_DAY, true, false), DocumentApp.HorizontalAlignment.LEFT);
}

function plain(p) {
  shape(p, base(SIZE_DAY, false, false), DocumentApp.HorizontalAlignment.LEFT);
}

function dayLine(p, day) {
  shape(p, base(SIZE_DAY, true, false), DocumentApp.HorizontalAlignment.LEFT);
  var text = p.getText();
  if (!text.length) return;
  var t = p.editAsText();
  // A rest line is bold up to the colon and plain after it, which is how they were typed.
  var from = Number(day.plainFrom);
  if (from >= 0 && from < text.length) t.setBold(from, text.length - 1, false);
  var bg = day.status === 'done' ? GREEN : day.status === 'missed' ? RED : null;
  if (bg) t.setBackgroundColor(0, text.length - 1, bg);
}
