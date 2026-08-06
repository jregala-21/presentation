const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');
const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = String(process.env.JWT_SECRET || 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET');
const PUBLIC_BRIDGE_URL = String(process.env.PUBLIC_BRIDGE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ONLYOFFICE_PUBLIC_URL = String(process.env.ONLYOFFICE_PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, '');
const ONLYOFFICE_INTERNAL_URL = String(process.env.ONLYOFFICE_INTERNAL_URL || ONLYOFFICE_PUBLIC_URL).replace(/\/$/, '');
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '*').split(',').map(v => v.trim()).filter(Boolean);
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data/sessions');
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 24 * 60 * 60 * 1000);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 250 * 1024 * 1024);

if (JWT_SECRET.length < 32 || JWT_SECRET.includes('CHANGE_ME')) {
  console.warn('WARNING: Set JWT_SECRET to a random value of at least 32 characters.');
}

const app = express();
app.use(morgan('combined'));
app.use(cors({origin(origin, cb) {
  if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
  cb(new Error('Origin is not allowed.'));
}}));
app.use(express.json({limit:'2mb'}));

const sessions = new Map();
const safeName = name => String(name || 'Presentation.pptx').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180);
const tokenFor = session => jwt.sign({sid:session.id, purpose:'session'}, JWT_SECRET, {expiresIn:'24h'});
const verifySessionToken = (session, token) => {
  const payload = jwt.verify(String(token || ''), JWT_SECRET);
  if (payload.sid !== session.id || payload.purpose !== 'session') throw new Error('Invalid session token.');
};
const getSession = id => {
  const session = sessions.get(String(id || ''));
  if (!session) throw new Error('Editing session was not found or expired.');
  return session;
};

async function downloadFromAppsScript(session) {
  const chunks = [];
  let start = 0, total = 0;
  while (true) {
    const url = new URL(session.appsScriptUrl);
    url.searchParams.set('action','downloadChunk');
    url.searchParams.set('fileId',session.fileId);
    url.searchParams.set('start',String(start));
    url.searchParams.set('end',String(start + 2 * 1024 * 1024 - 1));
    url.searchParams.set('_',String(Date.now()));
    const response = await fetch(url, {redirect:'follow'});
    if (!response.ok) throw new Error(`Apps Script download failed (${response.status}).`);
    const data = await response.json();
    if (data.success === false) throw new Error(data.error || 'Apps Script download failed.');
    const chunk = Buffer.from(data.base64Data || '', 'base64');
    chunks.push(chunk); total += chunk.length;
    if (total > MAX_FILE_BYTES) throw new Error('PowerPoint exceeds the configured size limit.');
    if (data.done || !chunk.length) break;
    start = Number(data.end) + 1;
  }
  const buffer = Buffer.concat(chunks);
  await fs.writeFile(session.originalPath, buffer);
  session.fileSize = buffer.length;
}

async function downloadEditedFile(session, url) {
  const response = await fetch(url, {redirect:'follow'});
  if (!response.ok) throw new Error(`ONLYOFFICE file download failed (${response.status}).`);
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_FILE_BYTES) throw new Error('Edited PowerPoint exceeds the configured size limit.');
  await fs.writeFile(session.latestPath, Buffer.from(arrayBuffer));
  session.revision += 1;
  session.fileReady = true;
  session.updatedAt = Date.now();
  session.message = 'Edited PowerPoint is ready.';
}

function editorConfig(session) {
  const fileUrl = `${PUBLIC_BRIDGE_URL}/api/sessions/${encodeURIComponent(session.id)}/source?token=${encodeURIComponent(session.token)}`;
  const callbackUrl = `${PUBLIC_BRIDGE_URL}/api/onlyoffice/callback/${encodeURIComponent(session.id)}`;
  const key = crypto.createHash('sha256').update(`${session.fileId}:${session.fileSize}:${session.createdAt}`).digest('hex').slice(0, 20);
  session.documentKey = key;
  const config = {
    documentType:'slide',
    type:'desktop',
    width:'100%', height:'100%',
    document:{
      fileType:'pptx', key, title:session.fileName, url:fileUrl,
      permissions:{edit:true,download:true,print:true,review:true,comment:true,fillForms:true}
    },
    editorConfig:{
      mode:'edit', callbackUrl,
      customization:{autosave:true,forcesave:true,compactHeader:false,help:true,feedback:false},
      user:{id:'presenter-user',name:'Presenter Operator'}
    }
  };
  config.token = jwt.sign(config, JWT_SECRET);
  return config;
}


function viewerConfig(session, mode = 'preview') {
  const currentPath = fssync.existsSync(session.latestPath) ? session.latestPath : session.originalPath;
  const stat = fssync.statSync(currentPath);
  const revisionTag = `${session.revision}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  const key = crypto.createHash('sha256')
    .update(`${session.fileId}:${revisionTag}:${mode}`)
    .digest('hex').slice(0, 20);
  const fileUrl = `${PUBLIC_BRIDGE_URL}/api/sessions/${encodeURIComponent(session.id)}/current?token=${encodeURIComponent(session.token)}&v=${encodeURIComponent(revisionTag)}`;
  const live = mode === 'live';
  const config = {
    documentType: 'slide',
    type: live ? 'embedded' : 'desktop',
    width: '100%',
    height: '100%',
    document: {
      fileType: 'pptx',
      key,
      title: session.fileName,
      url: fileUrl,
      permissions: {
        edit: false,
        download: false,
        print: false,
        review: false,
        comment: false,
        fillForms: false
      }
    },
    editorConfig: {
      mode: 'view',
      customization: {
        compactHeader: true,
        compactToolbar: true,
        hideRightMenu: true,
        hideRulers: true,
        help: false,
        feedback: false,
        toolbarNoTabs: true,
        slidePlayerBackground: '#000000'
      },
      user: { id: 'presenter-viewer', name: 'Presenter Viewer' }
    }
  };
  config.token = jwt.sign(config, JWT_SECRET);
  return config;
}

app.get('/health', (req,res) => res.json({success:true, service:'JIL ONLYOFFICE bridge'}));

// Direct browser upload for locally selected PPTX files. This avoids requiring
// Google Apps Script to download a file that is already available in the browser.
app.post('/api/sessions/upload', express.raw({type:'application/vnd.openxmlformats-officedocument.presentationml.presentation', limit:MAX_FILE_BYTES}), async (req,res) => {
  try {
    const fileName = safeName(req.query.fileName || req.headers['x-file-name'] || 'Presentation.pptx');
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (!buffer.length) throw new Error('The uploaded PowerPoint file is empty.');
    if (buffer.length > MAX_FILE_BYTES) throw new Error('PowerPoint exceeds the configured size limit.');
    const id = crypto.randomUUID();
    const dir = path.join(DATA_DIR, id); await fs.mkdir(dir, {recursive:true});
    const session = {
      id, fileId:`local-${id}`, fileName, appsScriptUrl:'', dir,
      originalPath:path.join(dir,'source.pptx'), latestPath:path.join(dir,'latest.pptx'),
      fileSize:buffer.length, createdAt:Date.now(), updatedAt:Date.now(),
      revision:0, fileReady:false, message:'Editor ready.', error:''
    };
    session.token = tokenFor(session);
    sessions.set(id, session);
    await fs.writeFile(session.originalPath, buffer);
    const config = editorConfig(session);
    res.json({success:true, sessionId:id, sessionToken:session.token, revision:session.revision,
      apiUrl:`${ONLYOFFICE_PUBLIC_URL}/web-apps/apps/api/documents/api.js`, config});
  } catch (error) {
  console.error('ONLYOFFICE callback failed:', {
    message: error.message,
    stack: error.stack,
    body: req.body,
    headers: req.headers
  });

  try {
    const session = sessions.get(req.params.id);
    if (session) {
      session.error = `ONLYOFFICE callback failed: ${error.message}`;
      session.message = session.error;
      session.updatedAt = Date.now();
    }
  } catch (_) {}

  res.json({ error: 1 });
}
});

app.post('/api/sessions', async (req,res) => {
  try {
    const fileId = String(req.body.fileId || '').trim();
    const fileName = safeName(req.body.fileName);
    const appsScriptUrl = String(req.body.appsScriptUrl || '').trim();
    if (!fileId || !appsScriptUrl) throw new Error('fileId and appsScriptUrl are required.');
    if (!/^https:\/\/script\.google\.com\//i.test(appsScriptUrl)) throw new Error('Only a Google Apps Script HTTPS URL is allowed.');
    const id = crypto.randomUUID();
    const dir = path.join(DATA_DIR, id); await fs.mkdir(dir, {recursive:true});
    const session = {
      id, fileId, fileName, appsScriptUrl, dir,
      originalPath:path.join(dir,'source.pptx'), latestPath:path.join(dir,'latest.pptx'),
      fileSize:Number(req.body.fileSize || 0), createdAt:Date.now(), updatedAt:Date.now(),
      revision:0, fileReady:false, message:'Downloading source PowerPoint...', error:''
    };
    session.token = tokenFor(session);
    sessions.set(id, session);
    await downloadFromAppsScript(session);
    session.message = 'Editor ready.';
    const config = editorConfig(session);
    res.json({success:true, sessionId:id, sessionToken:session.token, revision:session.revision,
      apiUrl:`${ONLYOFFICE_PUBLIC_URL}/web-apps/apps/api/documents/api.js`, config});
  } catch (error) {
  console.error('ONLYOFFICE callback failed:', {
    message: error.message,
    stack: error.stack,
    body: req.body,
    headers: req.headers
  });

  try {
    const session = sessions.get(req.params.id);
    if (session) {
      session.error = `ONLYOFFICE callback failed: ${error.message}`;
      session.message = session.error;
      session.updatedAt = Date.now();
    }
  } catch (_) {}

  res.json({ error: 1 });
}
});



app.post('/api/sessions/:id/view-config', (req, res) => {
  try {
    const session = getSession(req.params.id);
    verifySessionToken(session, req.body.sessionToken);
    const mode = String(req.body.mode || 'preview').toLowerCase() === 'live' ? 'live' : 'preview';
    session.updatedAt = Date.now();
    res.json({
      success: true,
      apiUrl: `${ONLYOFFICE_PUBLIC_URL}/web-apps/apps/api/documents/api.js`,
      revision: session.revision,
      config: viewerConfig(session, mode)
    });
  } catch (error) {
  console.error('ONLYOFFICE callback failed:', {
    message: error.message,
    stack: error.stack,
    body: req.body,
    headers: req.headers
  });

  try {
    const session = sessions.get(req.params.id);
    if (session) {
      session.error = `ONLYOFFICE callback failed: ${error.message}`;
      session.message = session.error;
      session.updatedAt = Date.now();
    }
  } catch (_) {}

  res.json({ error: 1 });
}
});

app.get('/api/sessions/:id/source', async (req,res) => {
  try {
    const session=getSession(req.params.id); verifySessionToken(session, req.query.token);
    res.type('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition',`inline; filename="${session.fileName.replace(/"/g,'')}"`);
    fssync.createReadStream(session.originalPath).pipe(res);
  } catch(error){res.status(403).send(error.message);}
});

app.post('/api/onlyoffice/callback/:id', async (req,res) => {
  try {
    const session=getSession(req.params.id);
    const auth=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    const callbackToken=auth || req.body.token;
    if(callbackToken){
      const decoded=jwt.verify(callbackToken,JWT_SECRET);
      if(decoded.key && session.documentKey && decoded.key!==session.documentKey) throw new Error('Document key mismatch.');
    }
    const status=Number(req.body.status||0);
    session.updatedAt=Date.now();
    if((status===2 || status===6) && req.body.url){
      session.fileReady=false; session.message='Downloading edited PowerPoint from ONLYOFFICE...';
      await downloadEditedFile(session,req.body.url);
    } else if(status===3 || status===7){
      session.error=String(req.body.error||'ONLYOFFICE reported a save error.');
    }
    res.json({error:0});
  } catch(error){console.error(error);res.json({error:1});}
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function requestOnlyOfficeForceSave(session) {
  const command = {
    c: 'forcesave',
    key: session.documentKey,
    userdata: `revision-${session.revision + 1}`
  };

  const token = jwt.sign(command, JWT_SECRET);

  const response = await fetch(
    `${ONLYOFFICE_INTERNAL_URL}/coauthoring/CommandService.ashx`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...command,
        token
      })
    }
  );

  const text = await response.text();

  let result = {};
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`Unreadable ONLYOFFICE command response: ${text}`);
  }

  return {
    response,
    text,
    result
  };
}

app.post('/api/sessions/:id/forcesave', async (req,res) => {
  try {
    const session=getSession(req.params.id); verifySessionToken(session,req.body.sessionToken);
    session.fileReady=false; session.error=''; session.message='Waiting for synchronized editor changes.';
    let last = null;
    for (let attempt=0; attempt<5; attempt+=1) {
      if (attempt) await delay(700 + attempt * 500);
      last = await requestOnlyOfficeForceSave(session);
      const errorCode=Number(last.result.error || 0);
      if (last.response.ok && errorCode===0) {
        session.message='Force-save accepted. Waiting for the edited PowerPoint.';
        return res.json({success:true,expectedRevision:session.revision+1});
      }
      if (errorCode!==4) {
        throw new Error(`ONLYOFFICE force-save failed: ${last.text}`);
      }
    }
    session.fileReady=fssync.existsSync(session.latestPath);
    session.message='No new synchronized changes were available to force-save.';
    return res.json({success:true,noChanges:true,expectedRevision:session.revision});
  }catch(error){res.status(400).json({success:false,error:error.message});}
});

app.get('/api/sessions/:id/current',(req,res)=>{
  try{
    const session=getSession(req.params.id); verifySessionToken(session,req.query.token);
    const filePath=fssync.existsSync(session.latestPath) ? session.latestPath : session.originalPath;
    res.type('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition',`attachment; filename="${session.fileName.replace(/"/g,'')}"`);
    fssync.createReadStream(filePath).pipe(res);
  }catch(error){res.status(403).send(error.message);}
});

app.get('/api/sessions/:id/status',(req,res)=>{
  try{const session=getSession(req.params.id);verifySessionToken(session,req.query.token);res.json({success:true,revision:session.revision,fileReady:session.fileReady,message:session.message,error:session.error});}
  catch(error){res.status(403).json({success:false,error:error.message});}
});

app.get('/api/sessions/:id/file',(req,res)=>{
  try{const session=getSession(req.params.id);verifySessionToken(session,req.query.token);if(!session.fileReady||!fssync.existsSync(session.latestPath))return res.status(409).send('Edited file is not ready.');res.type('application/vnd.openxmlformats-officedocument.presentationml.presentation');res.setHeader('Content-Disposition',`attachment; filename="${session.fileName.replace(/"/g,'')}"`);fssync.createReadStream(session.latestPath).pipe(res);}
  catch(error){res.status(403).send(error.message);}
});

app.post('/api/sessions/:id/close',async(req,res)=>{
  try{const session=getSession(req.params.id);verifySessionToken(session,req.body.sessionToken);sessions.delete(session.id);await fs.rm(session.dir,{recursive:true,force:true});res.json({success:true});}
  catch(error){res.status(400).json({success:false,error:error.message});}
});

setInterval(async()=>{const cutoff=Date.now()-SESSION_TTL_MS;for(const [id,s] of sessions){if(s.updatedAt<cutoff){sessions.delete(id);await fs.rm(s.dir,{recursive:true,force:true}).catch(()=>{});}}},60*60*1000).unref();

fs.mkdir(DATA_DIR,{recursive:true}).then(()=>app.listen(PORT,'0.0.0.0',()=>console.log(`ONLYOFFICE bridge listening on ${PORT}`)));
