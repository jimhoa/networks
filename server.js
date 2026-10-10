import http from 'node:http';
import {readFileSync, mkdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes, createCipheriv, createDecipheriv, timingSafeEqual} from 'node:crypto';
import {publishPost} from './publisher.js';

const port=Number(process.env.PORT||3000), base=process.env.APP_URL||`http://localhost:${port}`;
const production=process.env.NODE_ENV==='production';
if(production && (!base.startsWith('https://') || !process.env.APP_PASSWORD || !process.env.TOKEN_ENCRYPTION_KEY)) throw new Error('Production exige HTTPS, APP_PASSWORD et TOKEN_ENCRYPTION_KEY');
mkdirSync('.data',{recursive:true,mode:0o700});
const db=new DatabaseSync('.data/planner.sqlite');
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,token TEXT NOT NULL,expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY,account TEXT NOT NULL,text TEXT NOT NULL,scheduled TEXT,status TEXT NOT NULL,error TEXT,remote_id TEXT);`);
// Interrupted sends have an unknown outcome; never retry them automatically.
db.prepare("UPDATE posts SET status='uncertain',error='Envoi interrompu. Vérifiez LinkedIn avant de reprogrammer.' WHERE status='sending'").run();
const sessions=new Map(), states=new Map(), attempts=new Map();
const key=()=>{const value=process.env.TOKEN_ENCRYPTION_KEY||''; if(!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('TOKEN_ENCRYPTION_KEY doit contenir 64 caractères hexadécimaux'); return Buffer.from(value,'hex');};
function encrypt(text){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key(),iv);return [iv.toString('hex'),Buffer.concat([c.update(text,'utf8'),c.final()]).toString('hex'),c.getAuthTag().toString('hex')].join('.');}
function decrypt(text){const [iv,data,tag]=text.split('.');const d=createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'hex'));d.setAuthTag(Buffer.from(tag,'hex'));return Buffer.concat([d.update(Buffer.from(data,'hex')),d.final()]).toString();}
const id=()=>randomBytes(24).toString('hex');
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function body(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>16000)throw new Error('Requête trop grande');}return JSON.parse(raw||'{}');}
function session(req){const sid=/planner=([a-f0-9]+)/.exec(req.headers.cookie||'')?.[1]; const s=sessions.get(sid);return s&&s.expires>Date.now()?s:null;}
const publicAccounts=()=>db.prepare('SELECT id,name,kind,expires FROM accounts').all();
const configured=()=>Boolean(process.env.LINKEDIN_CLIENT_ID&&process.env.LINKEDIN_CLIENT_SECRET&&/^[a-fA-F0-9]{64}$/.test(process.env.TOKEN_ENCRYPTION_KEY||'')&&/^\d{6}$/.test(process.env.LINKEDIN_VERSION||''));
async function linkedin(path,token){const r=await fetch(`https://api.linkedin.com${path}`,{headers:{Authorization:`Bearer ${token}`,'LinkedIn-Version':process.env.LINKEDIN_VERSION,'X-Restli-Protocol-Version':'2.0.0'},signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`LinkedIn HTTP ${r.status}`);return r.json();}
function storeAccount(urn,name,kind,token,expires){db.prepare('INSERT OR REPLACE INTO accounts VALUES(?,?,?,?,?)').run(urn,name,kind,encrypt(token),expires);}
async function tick(){
 const due=db.prepare("SELECT * FROM posts WHERE status='scheduled' AND scheduled<=? ORDER BY scheduled LIMIT 5").all(new Date().toISOString());
 for(const p of due){
  const a=db.prepare('SELECT * FROM accounts WHERE id=?').get(p.account);
  if(!a||a.expires<=Date.now()||!configured()){db.prepare("UPDATE posts SET status='failed',error=? WHERE id=?").run('Connexion expirée ou configuration manquante. Reconnectez le compte.',p.id);continue;}
  const claimed=db.prepare("UPDATE posts SET status='sending' WHERE id=? AND status='scheduled'").run(p.id);if(!claimed.changes)continue;
  try{const remote=await publishPost({author:a.id,text:p.text,token:decrypt(a.token),version:process.env.LINKEDIN_VERSION});db.prepare("UPDATE posts SET status='published',remote_id=? WHERE id=?").run(remote,p.id);}
  catch(e){db.prepare("UPDATE posts SET status='uncertain',error=? WHERE id=?").run(`${e.message} Vérifiez LinkedIn : aucune relance automatique.`,p.id);}
 }
}
let running=false;setInterval(async()=>{if(running)return;running=true;try{await tick();}catch{console.error('Échec du traitement des publications');}finally{running=false;}},15000).unref();
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'");
 try{
 const u=new URL(req.url,base),s=session(req);
 if(!['GET','HEAD'].includes(req.method) && req.headers.origin!==new URL(base).origin)return json(res,403,{error:'Origine refusée'});
 if(u.pathname==='/api/login'&&req.method==='POST'){
  const address=req.socket.remoteAddress, now=Date.now(); const recent=(attempts.get(address)||[]).filter(t=>t>now-60000); if(recent.length>=10)return json(res,429,{error:'Trop de tentatives. Réessayez dans une minute.'}); recent.push(now); attempts.set(address,recent);
  const b=await body(req),expected=process.env.APP_PASSWORD||'',actual=String(b.password||'');
  if(expected&&(Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected))))return json(res,401,{error:'Mot de passe incorrect'});
  const sid=id();sessions.set(sid,{expires:Date.now()+8*3600000});res.setHeader('Set-Cookie',`planner=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${base.startsWith('https:')?'; Secure':''}`);return json(res,200,{ok:true});
 }
 if(u.pathname.startsWith('/api/')||u.pathname.startsWith('/auth/')){
  if(!s)return json(res,401,{error:'Connectez-vous à votre espace'});
  if(u.pathname==='/api/state')return json(res,200,{accounts:publicAccounts(),posts:db.prepare('SELECT * FROM posts ORDER BY scheduled DESC').all(),configured:configured(),localOnly:!process.env.APP_PASSWORD});
  if(u.pathname==='/auth/linkedin'){
   if(!configured())throw new Error('Configurez les identifiants LinkedIn, la clé de chiffrement et la version API');
   const state=id();states.set(state,{s,expires:Date.now()+600000});const url=new URL('https://www.linkedin.com/oauth/v2/authorization');url.search=new URLSearchParams({response_type:'code',client_id:process.env.LINKEDIN_CLIENT_ID,redirect_uri:`${base}/auth/callback`,state,scope:process.env.LINKEDIN_SCOPES||'openid profile w_member_social'});res.writeHead(302,{Location:url.href});return res.end();
  }
  if(u.pathname==='/auth/callback'){
   const saved=states.get(u.searchParams.get('state'));states.delete(u.searchParams.get('state'));if(!saved||saved.s!==s||saved.expires<Date.now()||!u.searchParams.get('code'))throw new Error('Connexion LinkedIn refusée ou expirée');
   const r=await fetch('https://www.linkedin.com/oauth/v2/accessToken',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:u.searchParams.get('code'),redirect_uri:`${base}/auth/callback`,client_id:process.env.LINKEDIN_CLIENT_ID,client_secret:process.env.LINKEDIN_CLIENT_SECRET}),signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`OAuth LinkedIn HTTP ${r.status}`);
   const t=await r.json(),profile=await linkedin('/v2/userinfo',t.access_token),expires=Date.now()+t.expires_in*1000;storeAccount(`urn:li:person:${profile.sub}`,profile.name||'Mon profil','person',t.access_token,expires);
   res.writeHead(302,{Location:'/'});return res.end();
  }
  if(u.pathname==='/api/pages'&&req.method==='POST'){
   const a=db.prepare("SELECT * FROM accounts WHERE kind='person' LIMIT 1").get();if(!a||a.expires<=Date.now())throw new Error('Connectez votre profil LinkedIn');
   const token=decrypt(a.token),acl=await linkedin('/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED',token);
   if(acl.paging?.total>acl.elements?.length)throw new Error('Liste paginée : import incomplet, contactez le développeur avant utilisation');
   for(const entry of acl.elements||[]){const urn=entry.organization;if(!/^urn:li:organization:\d+$/.test(urn||''))continue;const org=await linkedin(`/rest/organizations/${urn.split(':').at(-1)}`,token);storeAccount(urn,org.localizedName||urn,'organization',token,a.expires);}
   return json(res,200,{ok:true});
  }
  if(u.pathname==='/api/posts'&&req.method==='POST'){
   const b=await body(req);if(typeof b.text!=='string'||!b.text.trim()||b.text.length>3000)throw new Error('Texte requis, maximum 3000 caractères');
   const account=db.prepare('SELECT * FROM accounts WHERE id=?').get(String(b.account||''));
   if(b.schedule&&(!account||account.expires<=Date.now()||!configured()))throw new Error('Connectez un compte autorisé avant de programmer');
   const date=b.schedule?new Date(b.schedule):null;if(date&&(!Number.isFinite(date.getTime())||date.getTime()<Date.now()+60000))throw new Error('Choisissez une date au moins une minute dans le futur');
   const pid=id();db.prepare('INSERT INTO posts VALUES(?,?,?,?,?,?,?)').run(pid,account?.id||'',b.text,date?.toISOString()||null,date?'scheduled':'draft',null,null);return json(res,201,{id:pid});
  }
  if(/^\/api\/posts\/[a-f0-9]+$/.test(u.pathname)&&req.method==='DELETE'){
   const result=db.prepare("DELETE FROM posts WHERE id=? AND status IN ('draft','scheduled','failed')").run(u.pathname.split('/').at(-1));if(!result.changes)throw new Error('Publication déjà en cours ou état à vérifier');return json(res,200,{ok:true});
  }
  return json(res,404,{error:'Route inconnue'});
 }
 const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};if(!files[u.pathname])return json(res,404,{error:'Introuvable'});
 res.setHeader('Content-Type',u.pathname.endsWith('.js')?'text/javascript':u.pathname.endsWith('.css')?'text/css':'text/html');res.end(readFileSync(new URL(`./public/${files[u.pathname]}`,import.meta.url)));
 }catch(e){json(res,400,{error:e.message});}
});
server.listen(port,production?'0.0.0.0':'127.0.0.1',()=>console.log(`Planner démarré sur le port ${port}`));
