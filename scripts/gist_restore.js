#!/usr/bin/env node
/* Iron Hub — sync gist recovery tool.
 *
 * A gist keeps every revision forever, so an overwrite by a stale device is recoverable:
 * find the last revision written before the bad push and re-publish its payload.
 *
 * Usage (needs a GitHub token with the `gist` scope — the same one in Settings > Sync):
 *
 *   GH_TOKEN=ghp_xxx GIST_ID=abc123 node scripts/gist_restore.js list
 *   GH_TOKEN=ghp_xxx GIST_ID=abc123 node scripts/gist_restore.js show <sha>
 *   GH_TOKEN=ghp_xxx GIST_ID=abc123 node scripts/gist_restore.js restore <sha>
 *
 * `list` walks the revision history and prints, for each one, what the payload actually
 * CONTAINS (newest session, session count, newest weigh-in) rather than just its timestamp —
 * a stale push carries a fresh timestamp over old content, so the stamp alone cannot tell you
 * which revision is the good one.
 *
 * `restore` re-stamps `exportedAt` to now before pushing. That is load-bearing: every device
 * already advanced its `changedAt` watermark when it swallowed the bad snapshot, and
 * autoPullOnLoad()/bgSyncTick() only apply a pull when `exportedAt > changedAt`. Re-publishing
 * the old payload with its ORIGINAL stamp would sit on the gist and be ignored by every device.
 * It also writes the current (bad) gist content to disk first, so restore is itself undoable.
 */
const GIST_FILE = 'ironhub_data.json';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const GIST  = process.env.GIST_ID;

if(!TOKEN || !GIST){
  console.error('Set GH_TOKEN and GIST_ID. Both are in the app under Settings > Sync\n' +
                '(the gist id is also the last path segment of the gist URL on github.com).');
  process.exit(1);
}
const H = {Authorization:'Bearer '+TOKEN, Accept:'application/vnd.github+json'};

async function api(path){
  const r = await fetch('https://api.github.com'+path, {headers:H});
  if(!r.ok) throw new Error('GitHub '+r.status+' on '+path+(r.status===401?' — token invalid or missing the gist scope':''));
  return r.json();
}
// A large file comes back truncated with content omitted; raw_url always has the whole thing.
async function payloadAt(sha){
  const g = await api('/gists/'+GIST+(sha ? '/'+sha : ''));
  const f = g.files && g.files[GIST_FILE];
  if(!f) return null;
  const content = f.truncated ? await (await fetch(f.raw_url,{headers:H})).text() : f.content;
  try{ return JSON.parse(content); }catch(e){ return null; }
}
const dstr = t => t ? new Date(t).toISOString().slice(0,16).replace('T',' ') : '—';

/* The revision endpoint 422s on an abbreviated sha, but `list` prints abbreviated ones because
   full 40-char shas make the table unreadable. Resolve a prefix against the history first so
   what list prints is what show/restore accept. */
async function resolveSha(prefix){
  if(/^[0-9a-f]{40}$/.test(prefix)) return prefix;
  const g = await api('/gists/'+GIST);
  const hits = (g.history||[]).map(h=>h.version).filter(v => v.startsWith(prefix));
  if(!hits.length) throw new Error('No revision starts with '+prefix);
  if(hits.length > 1) throw new Error('Ambiguous prefix '+prefix+' — matches '+hits.length+' revisions');
  return hits[0];
}

function describe(p){
  const d = (p && p.data) || {};
  const logs = Array.isArray(d.logs) ? d.logs : [];
  const wts  = Array.isArray(d.weights) ? d.weights : [];
  const last = a => a.length ? a.map(r=>r && (r.date||r.d||'')).filter(Boolean).sort().pop() : '';
  return {
    exportedAt: p && p.exportedAt,
    sessions: logs.length,
    lastSession: last(logs) || '—',
    weighins: wts.length,
    lastWeighin: last(wts) || '—',
    nutrition: Array.isArray(d.nutrition) ? d.nutrition.length : 0
  };
}

(async () => {
  const [cmd, sha] = process.argv.slice(2);

  if(cmd === 'list'){
    const g = await api('/gists/'+GIST);
    const hist = g.history || [];
    console.log('Revisions of '+GIST_FILE+' (newest first). Pick the newest row whose CONTENT');
    console.log('looks right — not the newest timestamp.\n');
    console.log('  #  committed         sha       exportedAt        sess  last session  weighins  last weighin');
    for(let i=0; i<hist.length; i++){
      const h = hist[i];
      let info;
      try{ info = describe(await payloadAt(h.version)); }
      catch(e){ console.log(String(i).padStart(3)+'  '+h.committed_at.slice(0,16).replace('T',' ')+'  '+h.version.slice(0,7)+'  (unreadable: '+e.message+')'); continue; }
      if(!info){ console.log(String(i).padStart(3)+'  '+h.committed_at.slice(0,16).replace('T',' ')+'  '+h.version.slice(0,7)+'  (no '+GIST_FILE+' in this revision)'); continue; }
      console.log(
        String(i).padStart(3)+'  '+
        h.committed_at.slice(0,16).replace('T',' ')+'  '+
        h.version.slice(0,7)+'  '+
        dstr(info.exportedAt).padEnd(16)+'  '+
        String(info.sessions).padStart(4)+'  '+
        info.lastSession.padEnd(12)+'  '+
        String(info.weighins).padStart(8)+'  '+
        info.lastWeighin
      );
    }
    return;
  }

  if(cmd === 'show'){
    if(!sha){ console.error('show needs a sha (from `list`)'); process.exit(1); }
    const p = await payloadAt(await resolveSha(sha));
    if(!p){ console.error('No readable '+GIST_FILE+' at '+sha); process.exit(1); }
    const i = describe(p);
    console.log(JSON.stringify(i, null, 2));
    const logs = (p.data && p.data.logs) || [];
    console.log('\nLast 12 sessions in this revision:');
    logs.slice(-12).forEach(l => {
      const ents = l.entries || [];
      const sets = ents.reduce((n,e)=> n + ((e && e.sets) ? e.sets.length : 0), 0);
      console.log('  '+(l.date||'?')+'  '+(l.day||'')+'  '+ents.length+' exercises, '+sets+' sets');
    });
    const wts = (p.data && p.data.weights) || [];
    console.log('\nLast 6 weigh-ins:');
    wts.slice(-6).forEach(w => console.log('  '+(w.date||'?')+'  '+(w.lbs!=null?w.lbs+' lb':'?')));
    return;
  }

  if(cmd === 'restore'){
    if(!sha){ console.error('restore needs a sha (from `list`)'); process.exit(1); }
    const full = await resolveSha(sha);
    const good = await payloadAt(full);
    if(!good || !good.data || !good.data.logs){
      console.error('Revision '+full+' has no usable Iron Hub payload — aborting.'); process.exit(1);
    }
    // Snapshot what is on the gist right now before touching it, so this is reversible.
    const fs = require('fs');
    const cur = await payloadAt(null);
    const bak = 'gist_before_restore_'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
    fs.writeFileSync(bak, JSON.stringify(cur, null, 2));
    console.log('Current gist content saved to '+bak);

    const before = describe(good);
    // Re-stamp so every device's pull gate (exportedAt > changedAt) actually opens. changedAt
    // must stay strictly below exportedAt — a payload always stamps exportedAt after the
    // changedAt it carries, and applyPulled() relies on that ordering.
    const now = Date.now();
    good.exportedAt = now;
    good.data.meta = good.data.meta || {};
    good.data.meta.changedAt = now - 1000;
    good.data.meta.pushedAt  = now - 1000;

    const r = await fetch('https://api.github.com/gists/'+GIST, {
      method:'PATCH',
      headers:Object.assign({'Content-Type':'application/json'}, H),
      body:JSON.stringify({files:{[GIST_FILE]:{content:JSON.stringify(good)}}})
    });
    if(!r.ok){ console.error('Restore push failed ('+r.status+')'); process.exit(1); }
    console.log('\nRestored revision '+sha.slice(0,7)+' to the gist, re-stamped as new.');
    console.log('  sessions: '+before.sessions+'  (through '+before.lastSession+')');
    console.log('  weigh-ins: '+before.weighins+' (through '+before.lastWeighin+')');
    console.log('\nOpen Iron Hub on each device — the boot pull will take this copy.');
    return;
  }

  console.error('Commands: list | show <sha> | restore <sha>');
  process.exit(1);
})().catch(e => { console.error('Error: '+e.message); process.exit(1); });
