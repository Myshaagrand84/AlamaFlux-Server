// ============================================================
//  ALAMAFLUX GRADING SYSTEM — Auth via Server API + PostgreSQL
// ============================================================
//  FIX: Registration and login now go through the server API
//  (/api/register, /api/login) so accounts are persisted in
//  PostgreSQL and survive browser changes, cache clears, and
//  server restarts. Teacher grading data still lives in
//  localStorage per-user (offline-friendly).
// ============================================================

// ========== API BASE URL ==========
const API = '';  // same origin — server serves the frontend too

// ========== GRADE CONFIG (from XCEL workbook) ==========
const GRADE_CFG=[
{g:1,subjects:[{n:'ENGLISH',def:40},{n:'KISWAHILI',def:40},{n:'MATHEMATICS',def:40},{n:'ENVIRONMENTAL',def:40}]},
{g:2,subjects:[{n:'ENGLISH',def:40},{n:'KISWAHILI',def:40},{n:'MATHEMATICS',def:40},{n:'ENVIRONMENTAL',def:40}]},
{g:3,subjects:[{n:'ENGLISH',def:40},{n:'KISWAHILI',def:40},{n:'MATHEMATICS',def:40},{n:'ENVIRONMENTAL',def:40}]},
{g:4,subjects:[{n:'ENGLISH',def:40},{n:'KISWAHILI',def:40},{n:'MATHEMATICS',def:40},{n:'SCIENCE',def:40},{n:'C.A.S',def:40},{n:'S/S',def:40}]},
{g:5,subjects:[{n:'ENGLISH',def:40},{n:'KISWAHILI',def:40},{n:'MATHEMATICS',def:40},{n:'SCIENCE',def:40},{n:'C.A.S',def:40},{n:'S/S',def:40}]},
{g:6,subjects:[{n:'ENGLISH',def:70},{n:'KISWAHILI',def:70},{n:'MATHEMATICS',def:70},{n:'INTEGRATED',def:70},{n:'AGRICULTURE',def:100},{n:'C.A.S',def:70},{n:'CRE',def:70},{n:'S/S',def:70},{n:'PRE-TECHNICAL',def:100}]},
{g:7,subjects:[{n:'ENGLISH',def:70},{n:'KISWAHILI',def:70},{n:'MATHEMATICS',def:70},{n:'INTEGRATED',def:70},{n:'AGRICULTURE',def:100},{n:'C.A.S',def:70},{n:'CRE',def:70},{n:'S/S',def:70},{n:'PRE-TECHNICAL',def:100}]},
{g:8,subjects:[{n:'ENGLISH',def:70},{n:'KISWAHILI',def:70},{n:'MATHEMATICS',def:70},{n:'INTEGRATED',def:70},{n:'AGRICULTURE',def:100},{n:'C.A.S',def:70},{n:'CRE',def:70},{n:'S/S',def:70},{n:'PRE-TECHNICAL',def:100}]},
{g:9,subjects:[{n:'ENGLISH',def:70},{n:'KISWAHILI',def:70},{n:'MATHEMATICS',def:70},{n:'INTEGRATED',def:70},{n:'AGRICULTURE',def:100},{n:'C.A.S',def:70},{n:'CRE',def:70},{n:'S/S',def:70},{n:'PRE-TECHNICAL',def:100}]}
];
const MAX_LEARNERS=45;
const MPESA_AMOUNT=100;

const KNEC_GRADES=[
{pct:84,g:'A',pts:12},{pct:80,g:'A-',pts:11},{pct:75,g:'B+',pts:10},
{pct:70,g:'B',pts:9},{pct:65,g:'B-',pts:8},{pct:60,g:'C+',pts:7},
{pct:55,g:'C',pts:6},{pct:50,g:'C-',pts:5},{pct:45,g:'D+',pts:4},
{pct:40,g:'D',pts:3},{pct:35,g:'D-',pts:2},{pct:0,g:'E',pts:1}
];

const PL_LEVELS=[
{pct:90,level:8,band:'EE1',desc:'Exceeding Expectations'},
{pct:75,level:7,band:'EE2',desc:'Exceeding Expectations'},
{pct:58,level:6,band:'ME1',desc:'Meeting Expectations'},
{pct:41,level:5,band:'ME2',desc:'Meeting Expectations'},
{pct:31,level:4,band:'AE1',desc:'Approaching Expectations'},
{pct:21,level:3,band:'AE2',desc:'Approaching Expectations'},
{pct:11,level:2,band:'BE1',desc:'Below Expectations'},
{pct:1,level:1,band:'BE2',desc:'Below Expectations'}
];

function knecGrade(pct){for(const k of KNEC_GRADES)if(pct>=k.pct)return k;return{g:'E',pts:1}}
function plLevel(pct){for(const p of PL_LEVELS)if(pct>=p.pct)return p;return{level:1,band:'BE2',desc:'Below Expectations'}}

// ========== SESSION AND STATE ==========
let currentUser=null;
let currentGrade=1;
let sessionToken=null;

function userKey(){return 'nyak_'+currentUser.id}
function globalKey(k){return 'nyak_global_'+k}

let state={examName:'',examTerm:'',examYear:'',grades:{}};

function defaultGrade(g){
const cfg=GRADE_CFG.find(c=>c.g===g);
const learners=[];
for(let i=0;i<MAX_LEARNERS;i++) learners.push({name:'',adm:'',raws:cfg.subjects.map(()=>null)});
return{outOf:cfg.subjects.map(s=>s.def),learners};
}

function loadUserState(){
try{const s=localStorage.getItem(userKey()+'_data');if(s)state=JSON.parse(s)}catch(e){}
if(!state.grades)state.grades={};
for(let g=1;g<=9;g++){if(!state.grades[g])state.grades[g]=defaultGrade(g)}
}

function saveUserState(){
if(!currentUser)return;
try{localStorage.setItem(userKey()+'_data',JSON.stringify(state))}catch(e){}
}

let saveTimer=null;
function debounceSave(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveUserState();toast('💾 Saved')},800)}

// ========== PAYMENT DB (still localStorage for now) ==========
function getPayments(){try{return JSON.parse(localStorage.getItem(userKey()+'_payments'))||[]}catch(e){return[]}}
function savePayments(p){localStorage.setItem(userKey()+'_payments',JSON.stringify(p))}
function isGradePaid(grade){return true}
function getGradePayment(grade){return getPayments().find(p=>p.grade===grade&&p.status==='success')}

// ============================================================
//  AUTH — NOW GOES THROUGH SERVER API (PostgreSQL)
// ============================================================
function showAuth(which){
document.getElementById('authRegister').style.display=which==='register'?'flex':'none';
document.getElementById('authLogin').style.display=which==='login'?'flex':'none';
}

// --- REGISTER via server API ---
async function doRegister(){
const name=document.getElementById('regName').value.trim();
const email=document.getElementById('regEmail').value.trim().toLowerCase();
const phone=document.getElementById('regPhone').value.trim();
const school=document.getElementById('regSchool').value.trim();
const pw=document.getElementById('regPassword').value;
const confirm=document.getElementById('regConfirm').value;
const errBox=document.getElementById('regErrorBox');
const successBox=document.getElementById('regSuccessBox');

errBox.style.display='none';
successBox.style.display='none';

if(!name){errBox.textContent='Please enter your full name.';errBox.style.display='block';return}
if(!email||!email.includes('@')){errBox.textContent='Please enter a valid email address.';errBox.style.display='block';return}
if(!phone||phone.length<9){errBox.textContent='Please enter a valid phone number.';errBox.style.display='block';return}
if(!school){errBox.textContent='Please enter your school name.';errBox.style.display='block';return}
if(!pw||pw.length<6){errBox.textContent='Password must be at least 6 characters.';errBox.style.display='block';return}
if(pw!==confirm){errBox.textContent='Passwords do not match.';errBox.style.display='block';return}

try{
const res=await fetch(API+'/api/register',{
method:'POST',
headers:{'Content-Type':'application/json'},
body:JSON.stringify({name,email,phone,school,password:pw})
});
const data=await res.json();
if(!res.ok){
errBox.textContent=data.error||'Registration failed. Please try again.';
errBox.style.display='block';
return;
}
// Store the JWT token from server
sessionToken=data.token;
currentUser=data.user;
localStorage.setItem('nyak_session',JSON.stringify({userId:currentUser.id,token:sessionToken,savedAt:Date.now()}));
// Clear form
document.getElementById('regName').value='';
document.getElementById('regEmail').value='';
document.getElementById('regPhone').value='';
document.getElementById('regSchool').value='';
document.getElementById('regPassword').value='';
document.getElementById('regConfirm').value='';
successBox.textContent='Account created! Welcome, '+currentUser.name+'.';
successBox.style.display='block';
enterApp();
}catch(e){
errBox.textContent='Network error. Please check your connection and try again.';
errBox.style.display='block';
}
}

// --- LOGIN via server API ---
async function doLogin(){
const email=document.getElementById('loginEmail').value.trim().toLowerCase();
const pw=document.getElementById('loginPassword').value;
const errBox=document.getElementById('loginErrorBox');
const successBox=document.getElementById('loginSuccessBox');

errBox.style.display='none';
successBox.style.display='none';

if(!email||!email.includes('@')){errBox.textContent='Please enter a valid email address.';errBox.style.display='block';return}
if(!pw){errBox.textContent='Please enter your password.';errBox.style.display='block';return}

try{
const res=await fetch(API+'/api/login',{
method:'POST',
headers:{'Content-Type':'application/json'},
body:JSON.stringify({email,password:pw})
});
const data=await res.json();
if(!res.ok){
errBox.textContent=data.error||'Login failed. Check your email and password.';
errBox.style.display='block';
return;
}
sessionToken=data.token;
currentUser=data.user;
localStorage.setItem('nyak_session',JSON.stringify({userId:currentUser.id,token:sessionToken,savedAt:Date.now()}));
document.getElementById('loginEmail').value='';
document.getElementById('loginPassword').value='';
successBox.textContent='Welcome back, '+currentUser.name+'!';
successBox.style.display='block';
enterApp();
}catch(e){
errBox.textContent='Network error. Please check your connection and try again.';
errBox.style.display='block';
}
}

// --- Auto-login: check saved JWT on page load ---
async function tryAutoLogin(){
try{
const sessStr=localStorage.getItem('nyak_session');
if(!sessStr)return false;
const sess=JSON.parse(sessStr);
if(!sess.token)return false;
// Verify the token is still valid by calling /api/me
const res=await fetch(API+'/api/me',{
headers:{'Authorization':'Bearer '+sess.token}
});
if(!res.ok){
// Token expired or invalid — clear it
localStorage.removeItem('nyak_session');
return false;
}
const data=await res.json();
currentUser=data.user;
sessionToken=sess.token;
return true;
}catch(e){
return false;
}
}

// --- LOGOUT ---
function doLogout(){
if(currentUser)saveUserState();
currentUser=null;sessionToken=null;
localStorage.removeItem('nyak_session');
document.getElementById('appContainer').classList.remove('active');
showAuth('login');
document.getElementById('loginSuccessBox').textContent='You have been signed out.';
document.getElementById('loginSuccessBox').style.display='block';
}

function togglePw(id,btn){
const inp=document.getElementById(id);
if(inp.type==='password'){inp.type='text';btn.textContent='🙈'}
else{inp.type='password';btn.textContent='👁'}
}

// ========== ENTER APP ==========
function enterApp(){
document.getElementById('authRegister').style.display='none';
document.getElementById('authLogin').style.display='none';
document.getElementById('appContainer').classList.add('active');
document.getElementById('ddName').textContent=currentUser.name;
document.getElementById('ddEmail').textContent=currentUser.email;
document.getElementById('userBtnLabel').textContent='👤 '+currentUser.name.split(' ')[0];
const _sn=document.getElementById('schoolNameTop');if(_sn)_sn.value=currentUser.school||'';
loadUserState();
buildSidebar();
renderEntry();
}

// ========== SIDEBAR ==========
function buildSidebar(){
const sb=document.getElementById('sidebar');
let h='<div class="side-label">Lower Primary</div>';
[1,2,3].forEach(g=>{h+=`<button class="grade-btn${g===currentGrade?' active':''}" onclick="switchGrade(${g})">Grade ${g}</button>`});
h+='<div class="sep"></div><div class="side-label">Upper Primary</div>';
[4,5,6].forEach(g=>{h+=`<button class="grade-btn${g===currentGrade?' active':''}" onclick="switchGrade(${g})">Grade ${g}</button>`});
h+='<div class="sep"></div><div class="side-label">Junior School</div>';
[7,8,9].forEach(g=>{h+=`<button class="grade-btn${g===currentGrade?' active':''}" onclick="switchGrade(${g})">Grade ${g}</button>`});
h+='<div class="sep"></div><div class="side-label">Report Access</div>';
if(isGradePaid(currentGrade)){h+='<div class="pay-status"><span class="ps-badge paid">✅ Paid — Unlocked</span></div>'}
else{h+='<div class="pay-status"><span class="ps-badge locked">🔒 KSh 100 to unlock</span></div>'}
h+='</div>';
sb.innerHTML=h;
}

function switchGrade(g){
saveUserState();
currentGrade=g;
buildSidebar();
renderEntry();
document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
document.querySelector('.tab-btn[data-view="entry"]').classList.add('active');
showViewByName('entry');
}

// ========== ENTRY TABLE ==========
function renderEntry(){
const cfg=GRADE_CFG.find(c=>c.g===currentGrade);
const gd=state.grades[currentGrade];
const nSubj=cfg.subjects.length;
const computedAll=computeAll();
let h='<table class="entry-table"><thead>';
h+='<tr class="r3"><th class="frozen fro-no">NO</th><th class="frozen fro-adm">ADM NO</th><th class="frozen fro-name">LEARNER NAME</th>';
cfg.subjects.forEach((s,si)=>{
h+=`<th colspan="4">${s.n}<br><input value="${gd.outOf[si]}" onchange="updateOutOf(${si},this.value)" style="width:34px;text-align:center;border:1px solid var(--g3);border-radius:3px;padding:1px 2px;font-size:10px;color:var(--blue);font-weight:700;background:var(--blue-l)"> /</th>`;
});
h+=`<th colspan="4">SUMMARY</th></tr>`;
h+='<tr class="r4">';
cfg.subjects.forEach((s,si)=>{
const b=si===0?'border-left:3px solid var(--g1)':'';
h+=`<th style="${b}">RAW</th><th>%</th><th>P/L</th><th>KNEC</th>`;
});
h+='<th>AVG %</th><th>Grade</th><th>Pts</th><th>Mean Gr</th></tr>';
h+='<tr class="r5">';
cfg.subjects.forEach((s,si)=>{
const b=si===0?'subj-first':'';
h+=`<th class="${b}" style="font-size:8px">RAW</th><th>%</th><th>P/L</th><th>KNEC</th>`;
});
h+='<th>AVG</th><th>Gr</th><th>Pts</th><th>Mean</th></tr></thead><tbody>';

gd.learners.forEach((lr,i)=>{
const comp=computedAll[i];
h+=`<tr>`;
h+=`<td class="frozen fro-no">${lr.name?(i+1):''}</td>`;
h+=`<td class="frozen fro-adm"><input value="${esc(lr.adm)}" oninput="updAdm(${i},this.value)" style="width:100%;border:none;background:transparent;font-size:10px;outline:none"></td>`;
h+=`<td class="frozen fro-name"><input value="${esc(lr.name)}" oninput="updName(${i},this.value)" style="width:100%;border:none;background:transparent;font-size:10px;outline:none"></td>`;
cfg.subjects.forEach((s,si)=>{
const raw=lr.raws[si];
const pct=comp.pcts[si];
const pl=comp.pls[si];
const knec=comp.knecs[si];
const b=si===0?'subj-first':'';
const isAbs=raw==='ABS';
const isOver=raw!==null&&raw!=='ABS'&&parseFloat(raw)>gd.outOf[si];
h+=`<td class="raw-input ${b}"><input value="${isAbs?'ABS':(raw!==null?raw:'')}" oninput="updRaw(${i},${si},this)" onblur="finishRaw(${i},${si},this)" onkeydown="navKey(event,${i},${si},this)" class="${isOver?'over-warning':''}" style="width:100%;border:none;background:transparent;text-align:center;font-size:11px;color:#000;outline:none;padding:0"></td>`;
h+=`<td class="calc pct">${pct!==null?pct+'%':''}</td>`;
const plCls=pl?`pl-${pl}`:'';
h+=`<td class="calc ${plCls}">${pl||''}</td>`;
const knCls=knec?`knec-${knec}`:'';
h+=`<td class="calc ${knCls}">${knec||''}</td>`;
});
h+=`<td class="calc summ summ-avg">${comp.avgPct!==null?comp.avgPct+'%':''}</td>`;
h+=`<td class="calc summ">${comp.avgGrade||''}</td>`;
h+=`<td class="calc summ">${comp.totalPts!==null?comp.totalPts:''}</td>`;
h+=`<td class="calc summ summ-pos">${comp.meanGrade||''}</td>`;
h+='</tr>';
});

const mss=computeMSS(computedAll);
h+='<tr class="mss-row"><td class="frozen" colspan="3" style="text-align:left;padding-left:8px">Mean Subject Score</td>';
cfg.subjects.forEach((s,si)=>{
const b=si===0?'subj-first':'';
h+=`<td class="summ ${b}">${mss.rawAvgs[si]!==null?mss.rawAvgs[si]:''}</td>`;
h+=`<td class="summ pct">${mss.pctAvgs[si]!==null?mss.pctAvgs[si]+'%':''}</td>`;
h+=`<td class="summ">${mss.plModes[si]||''}</td>`;
h+=`<td class="summ">${mss.knecAvgs[si]||''}</td>`;
});
h+=`<td class="summ summ-avg">${mss.overallAvg!==null?mss.overallAvg+'%':''}</td>
<td class="summ">${mss.overallGrade||''}</td>
<td class="summ">${mss.overallPts||''}</td>
<td class="summ summ-pos">${mss.overallMean||''}</td>`;
h+='</tr></tbody></table>';
document.getElementById('sheetWrap').innerHTML=h;
}

function esc(s){return s?String(s).replace(/"/g,'&quot;'):''}

// ========== COMPUTATION ==========
function computeAll(){
const cfg=GRADE_CFG.find(c=>c.g===currentGrade);
const gd=state.grades[currentGrade];
return gd.learners.map(lr=>{
const pcts=[],pls=[],knecs=[];
let validPcts=0,sumPcts=0,sumPts=0,validPts=0;
cfg.subjects.forEach((s,si)=>{
const raw=lr.raws[si];
if(raw===null||raw===''||raw==='ABS'){pcts.push(null);pls.push(null);knecs.push(null);return}
const r=parseFloat(raw);
if(isNaN(r)||r<0){pcts.push(null);pls.push(null);knecs.push(null);return}
const o=gd.outOf[si]||100;
const pct=o>0?Math.round(r/o*1000)/10:0;
pcts.push(pct);
const pl=pct>=0?plLevel(pct):null;
pls.push(pl?pl.level:null);
const kg=pct>=0?knecGrade(pct):null;
knecs.push(kg?kg.g:null);
if(kg){sumPts+=kg.pts;validPts++}
validPcts++;sumPcts+=pct;
});
const avgPct=validPcts>0?Math.round(sumPcts/validPcts*10)/10:null;
const avgGrade=avgPct!==null?knecGrade(avgPct).g:null;
const totalPts=validPts>0?sumPts:null;
const meanGrade=avgPct!==null?knecGrade(avgPct).g:null;
const avgPL=avgPct!==null?plLevel(avgPct).level:null;
return{pcts,pls,knecs,avgPct,avgGrade,avgPL,totalPts,meanGrade};
});
}

function computeMSS(computedAll){
const cfg=GRADE_CFG.find(c=>c.g===currentGrade);
const gd=state.grades[currentGrade];
const rawAvgs=[],pctAvgs=[],plModes=[],knecAvgs=[];
cfg.subjects.forEach((s,si)=>{
let rawSum=0,rawN=0,pctSum=0,pctN=0;
const plCounts={1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0};
let knecPtsSum=0,knecPtsN=0;
gd.learners.forEach((lr,li)=>{
const raw=lr.raws[si];
if(raw!==null&&raw!==''&&raw!=='ABS'){const r=parseFloat(raw);if(!isNaN(r)&&r>=0){rawSum+=r;rawN++}}
const pct=computedAll[li].pcts[si];
if(pct!==null){pctSum+=pct;pctN++}
const pl=computedAll[li].pls[si];if(pl)plCounts[pl]=(plCounts[pl]||0)+1;
const kg=computedAll[li].knecs[si];if(kg){const k=KNEC_GRADES.find(kk=>kk.g===kg);if(k){knecPtsSum+=k.pts;knecPtsN++}}
});
rawAvgs.push(rawN>0?Math.round(rawSum/rawN*10)/10:null);
pctAvgs.push(pctN>0?Math.round(pctSum/pctN*10)/10:null);
let modePL=null,maxC=0;for(const[lvl,cnt]of Object.entries(plCounts)){if(cnt>maxC){maxC=cnt;modePL=lvl}}
plModes.push(modePL||null);
knecAvgs.push(knecPtsN>0?knecGrade(Math.round(knecPtsSum/knecPtsN*10)/10).g:null);
});
let allPcts=[];computedAll.forEach(c=>{if(c.avgPct!==null)allPcts.push(c.avgPct)});
const overallAvg=allPcts.length>0?Math.round(allPcts.reduce((a,b)=>a+b,0)/allPcts.length*10)/10:null;
const overallGrade=overallAvg?knecGrade(overallAvg).g:null;
let allPts=[];computedAll.forEach(c=>{if(c.totalPts!==null)allPts.push(c.totalPts)});
const overallPts=allPts.length>0?allPts.reduce((a,b)=>a+b+0):null;
const overallMean=overallAvg?knecGrade(overallAvg).g:null;
return{rawAvgs,pctAvgs,plModes,knecAvgs,overallAvg,overallGrade,overallPts,overallMean};
}

function computePositions(computedAll){
const gd=state.grades[currentGrade];
return gd.learners.map((lr,i)=>({i,avg:computedAll[i].avgPct,name:lr.name,adm:lr.adm}))
.filter(x=>x.name&&x.avg!==null)
.sort((a,b)=>b.avg-a.avg)
.map((x,idx,arr)=>({...x,pos:idx>0&&arr[idx-1].avg===x.avg?arr[idx-1].pos:idx+1}));
}

// ========== INPUT HANDLERS ==========
function updName(i,v){state.grades[currentGrade].learners[i].name=v.trim();debounceSave();renderEntry()}
function updAdm(i,v){state.grades[currentGrade].learners[i].adm=v.trim();debounceSave()}

function updRaw(i,si,el){
const gd=state.grades[currentGrade];
let v=el.value.trim();
if(v===''){gd.learners[i].raws[si]=null;debounceSave();return}
if(v.toUpperCase()==='ABS'||v.toUpperCase()==='A'){gd.learners[i].raws[si]='ABS';debounceSave();return}
let num=parseFloat(v);
if(isNaN(num)){gd.learners[i].raws[si]=null}
else{
if(num>100){num=100;el.value='100'}
gd.learners[i].raws[si]=num;
}
debounceSave();
}

function finishRaw(i,si,el){
updRaw(i,si,el);
renderEntry();
if(window._pendingFocus){
const pf=window._pendingFocus;
window._pendingFocus=null;
setTimeout(()=>focusCell(pf.i,pf.si),0);
}
}

function updateOutOf(si,v){
const gd=state.grades[currentGrade];
let n=parseInt(v);if(isNaN(n)||n<1)n=1;if(n>100)n=100;
gd.outOf[si]=n;debounceSave();renderEntry();
}

// ========== KEYBOARD NAVIGATION ==========
function navKey(e,i,si,el){
const cfg=GRADE_CFG.find(c=>c.g===currentGrade);
const nSubj=cfg.subjects.length;
if(e.key==='Tab'||e.key==='Enter'){
e.preventDefault();
const back=e.shiftKey;
let ni=i,nsi=si;
if(back){if(si>0)nsi=si-1;else if(i>0){ni=i-1;nsi=nSubj-1}}
else{if(si<nSubj-1)nsi=si+1;else if(i<MAX_LEARNERS-1){ni=i+1;nsi=0}}
if(ni!==i||nsi!==si){
window._pendingFocus={i:ni,si:nsi};
el.blur();
}
}
if(e.key==='ArrowDown'){e.preventDefault();window._pendingFocus={i:Math.min(i+1,MAX_LEARNERS-1),si};el.blur()}
if(e.key==='ArrowUp'){e.preventDefault();window._pendingFocus={i:Math.max(i-1,0),si};el.blur()}
if(e.key==='ArrowRight'&&el.selectionStart===el.value.length){e.preventDefault();if(si<nSubj-1){window._pendingFocus={i,si:si+1};el.blur()}}
if(e.key==='ArrowLeft'&&el.selectionStart===0){e.preventDefault();if(si>0){window._pendingFocus={i,si:si-1};el.blur()}}
}

function focusCell(i,si){
const inp=document.querySelector(`.entry-table tbody tr:nth-child(${i+1}) td.raw-input:nth-of-type(${si*4+1}) input`);
if(inp)inp.focus();
}

// ========== TOAST ==========
function toast(msg,dur){
dur=dur||2000;
const t=document.createElement('div');
t.style.cssText='position:fixed;bottom:20px;right:20px;background:#333;color:#fff;padding:8px 16px;border-radius:6px;font-size:12px;z-index:9999;opacity:0;transition:opacity .3s';
t.textContent=msg;
document.body.appendChild(t);
requestAnimationFrame(()=>t.style.opacity='1');
setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),300)},dur);
}

// ========== VIEWS ==========
function showView(v,btn){
['viewEntry','viewScoresheet','viewReports','viewKPI','viewProfile','viewPayments'].forEach(p=>document.getElementById(p).style.display='none');
if(btn)document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
if(btn)btn.classList.add('active');
const map={entry:'viewEntry',scoresheet:'viewScoresheet',reports:'viewReports',kpi:'viewKPI',profile:'viewProfile',payments:'viewPayments'};
document.getElementById(map[v]).style.display='block';
if(v==='scoresheet')renderScoresheet();
if(v==='reports')renderReports();
if(v==='kpi')renderKPI();
if(v==='profile')renderProfile();
if(v==='payments')renderPaymentHistory();
closeUserDD();
}

function showViewByName(v){
const map={entry:'viewEntry',scoresheet:'viewScoresheet',reports:'viewReports',kpi:'viewKPI',profile:'viewProfile',payments:'viewPayments'};
['viewEntry','viewScoresheet','viewReports','viewKPI','viewProfile','viewPayments'].forEach(p=>document.getElementById(p).style.display=p===map[v]?'block':'none');
}

// ========== USER DROPDOWN ==========
function toggleUserDD(){document.getElementById('userDropdown').classList.toggle('show')}
function closeUserDD(){document.getElementById('userDropdown').classList.remove('show')}

// ========== PROFILE ==========
function renderProfile(){
if(!currentUser)return;
const p=document.getElementById('viewProfile');
p.innerHTML=`
<div class="scorecard">
<h2>👤 My Profile</h2>
<table style="width:100%;border-collapse:collapse">
<tr><td style="padding:6px;font-weight:700;color:var(--g2);width:130px">Name</td><td style="padding:6px">${esc(currentUser.name)}</td></tr>
<tr><td style="padding:6px;font-weight:700;color:var(--g2)">Email</td><td style="padding:6px">${esc(currentUser.email)}</td></tr>
<tr><td style="padding:6px;font-weight:700;color:var(--g2)">Phone</td><td style="padding:6px">${esc(currentUser.phone||'—')}</td></tr>
<tr><td style="padding:6px;font-weight:700;color:var(--g2)">School</td><td style="padding:6px">${esc(currentUser.school||'—')}</td></tr>
<tr><td style="padding:6px;font-weight:700;color:var(--g2)">Account Created</td><td style="padding:6px">${currentUser.createdAt?new Date(currentUser.createdAt).toLocaleDateString():'—'}</td></tr>
<tr><td style="padding:6px;font-weight:700;color:var(--g2)">Last Login</td><td style="padding:6px">${currentUser.lastLoginAt?new Date(currentUser.lastLoginAt).toLocaleString():'—'}</td></tr>
</table>
</div>`;
}

// ========== PAYMENT HISTORY ==========
function renderPaymentHistory(){
const p=document.getElementById('viewPayments');
const payments=getPayments();
if(payments.length===0){
p.innerHTML='<div class="scorecard"><h2>💳 Payment History</h2><p style="color:var(--gray);font-size:12px;margin-top:10px">No payments yet.</p></div>';
return;
}
let rows=payments.map(p=>`<tr><td style="padding:5px">${p.grade||'—'}</td><td style="padding:5px">KSh ${p.amount||100}</td><td style="padding:5px">${p.status||'—'}</td><td style="padding:5px">${p.date?new Date(p.date).toLocaleString():'—'}</td></tr>`).join('');
p.innerHTML=`<div class="scorecard"><h2>💳 Payment History</h2><table style="width:100%;border-collapse:collapse;margin-top:8px"><tr style="background:var(--g5)"><th style="padding:5px">Grade</th><th style="padding:5px">Amount</th><th style="padding:5px">Status</th><th style="padding:5px">Date</th></tr>${rows}</table></div>`;
}

// ========== SCORESHEET ==========
function renderScoresheet(){
const cfg=GRADE_CFG.find(c=>c.g===currentGrade);
const gd=state.grades[currentGrade];
const computedAll=computeAll();
const positions=computePositions(computedAll);
const wrap=document.getElementById('viewScoresheet');
let h='';
positions.forEach(x=>{
const lr=gd.learners[x.i];
const comp=computedAll[x.i];
h+=`<div class="scorecard"><h2>${esc(lr.name)} — Grade ${currentGrade}</h2>
<div style="font-size:11px;color:var(--gray);margin-bottom:8px">ADM: ${esc(lr.adm||'—')} | Position: ${x.pos}</div>
<table><tr><th>Subject</th><th>Raw</th><th>Out Of</th><th>%</th><th>P/L</th><th>KNEC</th></tr>`;
cfg.subjects.forEach((s,si)=>{
const raw=lr.raws[si];
const pct=comp.pcts[si];
const pl=comp.pls[si];
const knec=comp.knecs[si];
const plObj=pl?PL_LEVELS.find(p=>p.level===pl):null;
h+=`<tr><td style="text-align:left;font-weight:600">${s.n}</td><td>${raw==='ABS'?'ABS':(raw!==null?raw:'—')}</td><td>${gd.outOf[si]}</td><td>${pct!==null?pct+'%':'—'}</td><td>${plObj?plObj.band:'—'}</td><td>${knec||'—'}</td></tr>`;
});
h+=`<tr style="background:var(--g5);font-weight:700"><td>Total / Average</td><td>—</td><td>—</td><td>${comp.avgPct!==null?comp.avgPct+'%':'—'}</td><td>—</td><td>${comp.avgGrade||'—'}</td></tr></table></div>`;
});
if(positions.length===0)h='<div class="scorecard"><p style="color:var(--gray)">No learners entered yet. Add names in the Entry tab.</p></div>';
wrap.innerHTML=h;
}

// ========== REPORTS ==========
function renderReports(){
const cfg=GRADE_CFG.find(c=>c.g===currentGrade);
const gd=state.grades[currentGrade];
const computedAll=computeAll();
const positions=computePositions(computedAll);
const wrap=document.getElementById('viewReports');
let h='';
positions.forEach(x=>{
const lr=gd.learners[x.i];
const comp=computedAll[x.i];
const avgPL=comp.avgPL?PL_LEVELS.find(p=>p.level===comp.avgPL):null;
h+=`<div class="report-card">
<div class="school-name">${esc(currentUser.school||'School Name')}</div>
<div class="subtitle">${esc(state.examName||'Exam')}, Term ${state.examTerm||'—'}, ${state.examYear||new Date().getFullYear()} | Grade ${currentGrade}</div>
<div class="learner-info">
<span><span class="lbl">Name:</span> ${esc(lr.name)}</span>
<span><span class="lbl">ADM:</span> ${esc(lr.adm||'—')}</span>
<span><span class="lbl">Position:</span> ${x.pos}</span>
<span><span class="lbl">Average:</span> ${comp.avgPct!==null?comp.avgPct+'%':'—'}</span>
</div>
<table class="rpt"><tr><th>Subject</th><th>Raw</th><th>Out Of</th><th>%</th><th>Level</th><th>Band</th><th>KNEC</th></tr>`;
cfg.subjects.forEach((s,si)=>{
const raw=lr.raws[si];
const pct=comp.pcts[si];
const pl=comp.pls[si];
const knec=comp.knecs[si];
const plObj=pl?PL_LEVELS.find(p=>p.level===pl):null;
h+=`<tr><td class="subj-name">${s.n}</td><td>${raw==='ABS'?'ABS':(raw!==null?raw:'—')}</td><td>${gd.outOf[si]}</td><td>${pct!==null?pct:'—'}</td><td>${pl||'—'}</td><td>${plObj?plObj.band:'—'}</td><td>${knec||'—'}</td></tr>`;
});
h+=`<tr class="totals-row"><td style="text-align:left;font-weight:700">Average</td><td>—</td><td>—</td><td>${comp.avgPct!==null?comp.avgPct:'—'}</td><td>${comp.avgPL||'—'}</td><td>${avgPL?avgPL.band:'—'}</td><td>${comp.avgGrade||'—'}</td></tr></table>
<div class="legend">P/L = Performance Level (1-8 CBE Scale). Band: EE=Exceeding, ME=Meeting, AE=Approaching, BE=Below.</div>
<div class="sig-lines"><div>Class Teacher</div><div>Headteacher</div><div>Parent/Guardian</div></div></div>`;
});
if(positions.length===0)h='<div class="scorecard"><p style="color:var(--gray)">No learners entered yet.</p></div>';
wrap.innerHTML=h;
}

// ========== KPI ==========
function renderKPI(){
const cfg=GRADE_CFG.find(c=>c.g===currentGrade);
const gd=state.grades[currentGrade];
const computedAll=computeAll();
const mss=computeMSS(computedAll);
const positions=computePositions(computedAll);
const wrap=document.getElementById('viewKPI');
const totalLearners=positions.length;
const overallAvg=mss.overallAvg||0;
const aboveME=positions.filter(x=>x.avg>=58).length;
const belowAE=positions.filter(x=>x.avg<31).length;

let distH='';
PL_LEVELS.forEach(lv=>{
const count=positions.filter(x=>x.avg!==null&&plLevel(x.avg).level===lv.level).length;
const pct=totalLearners>0?Math.round(count/totalLearners*100):0;
distH+=`<tr><td>${lv.level}</td><td>${lv.band}</td><td>${lv.desc}</td><td>${count}</td><td><div class="dist-bar" style="width:${pct}%"></div> ${pct}%</td></tr>`;
});

wrap.innerHTML=`
<div class="kpi-card" style="margin-bottom:14px">
<h3>📊 Grade ${currentGrade} KPIs</h3>
<div class="kpi-big">${overallAvg}%<small>Class Average</small></div>
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;text-align:center">
<div><div style="font-size:20px;font-weight:800;color:var(--g1)">${totalLearners}</div><div style="font-size:10px;color:var(--gray)">Learners</div></div>
<div><div style="font-size:20px;font-weight:800;color:#1B5E20">${aboveME}</div><div style="font-size:10px;color:var(--gray)">Meeting+</div></div>
<div><div style="font-size:20px;font-weight:800;color:var(--red)">${belowAE}</div><div style="font-size:10px;color:var(--gray)">Below Exp.</div></div>
</div>
</div>
<div class="kpi-card">
<h3>CBE Level Distribution</h3>
<table class="dist-table"><tr><th>Level</th><th>Band</th><th>Description</th><th>Count</th><th>Chart</th></tr>${distH}</table>
</div>`;
}

// ========== M-PESA ==========
function openMpesa(){
document.getElementById('mpesaOverlay').style.display='flex';
document.getElementById('mpesaGrade').textContent=currentGrade;
}
function closeMpesa(){
document.getElementById('mpesaOverlay').style.display='none';
document.getElementById('mpesaStep1').style.display='block';
document.getElementById('mpesaStep2').style.display='none';
document.getElementById('mpesaStep3').style.display='none';
document.getElementById('mpesaStep4').style.display='none';
document.getElementById('mpesaStep5').style.display='none';
}

// ========== INIT ON PAGE LOAD ==========
async function initApp(){
// Try auto-login with saved server JWT
const ok=await tryAutoLogin();
if(ok){
enterApp();
}else{
showAuth('login');
}
}

// Start the app when the page loads
document.addEventListener('DOMContentLoaded',initApp);
