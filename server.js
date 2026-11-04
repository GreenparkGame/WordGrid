'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=__dirname,PORT=Number(process.env.PORT||3000),rooms=new Map(),dictionary=new Set(JSON.parse(fs.readFileSync(path.join(ROOT,'dictionary.json'))));
const uid=()=>crypto.randomBytes(18).toString('hex');
const code=()=>crypto.randomBytes(4).toString('hex').slice(0,6).toUpperCase();
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))};
const error=(message,status=400)=>Object.assign(new Error(message),{status});
function body(req){return new Promise((resolve,reject)=>{let data='';req.on('data',chunk=>{data+=chunk;if(data.length>30000){reject(error('Request too large',413));req.destroy()}});req.on('end',()=>{try{resolve(JSON.parse(data||'{}'))}catch{reject(error('Invalid JSON'))}});req.on('error',reject)})}
const publicRoom=r=>({code:r.code,board:r.board,status:r.status,duration:r.duration,startedAt:r.startedAt,players:r.players.map(p=>({username:p.username,host:p.host,score:p.score})),discoveries:r.discoveries.slice(-200)});
const neighbours=i=>{const r=Math.floor(i/10),c=i%10,a=[];for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){const rr=r+dr,cc=c+dc;if((dr||dc)&&rr>=0&&rr<10&&cc>=0&&cc<10)a.push(rr*10+cc)}return a};
function pathValid(word,indices,board){return Array.isArray(indices)&&indices.length===word.length&&new Set(indices).size===indices.length&&indices.every((i,k)=>Number.isInteger(i)&&i>=0&&i<100&&board[i]===word[k]&&(!k||neighbours(indices[k-1]).includes(i)))}
function roomFor(code){const r=rooms.get(code.toUpperCase());if(!r)throw error('Room not found. Ask the teacher for the current code.',404);return r}
function member(r,token){const p=r.players.find(x=>x.token===token);if(!p)throw error('You are not in this room.',403);return p}
async function api(req,res,url){const parts=url.pathname.split('/').filter(Boolean);try{
if(req.method==='POST'&&parts.length===2&&parts[1]==='rooms'){
 const b=await body(req);if(!Array.isArray(b.board)||b.board.length!==100||b.board.some(x=>!/^[a-z]$/.test(x)))throw error('Invalid board');if(!Number.isInteger(b.duration)||b.duration<30||b.duration>600)throw error('Invalid duration');let id=code();while(rooms.has(id))id=code();const token=uid(),r={code:id,board:b.board,duration:b.duration,status:'lobby',startedAt:0,createdAt:Date.now(),players:[{token,username:'Teacher',host:true,score:0,found:new Set()}],discoveries:[],customWords:Array.isArray(b.words)&&b.mode==='custom'?b.words.filter(x=>/^[a-z]{3,16}$/.test(x)).slice(0,10):[]};rooms.set(id,r);return json(res,201,{code:id,token,room:publicRoom(r)})}
if(parts.length<3||parts[1]!=='rooms')throw error('Unknown endpoint',404);const r=roomFor(parts[2]),action=parts[3];
if(req.method==='GET'&&!action){if(r.status==='playing'&&Date.now()-r.startedAt>=r.duration*1000)r.status='finished';return json(res,200,{room:publicRoom(r)})}
if(req.method!=='POST')throw error('Method not allowed',405);const b=await body(req);
if(action==='join'){if(r.status!=='lobby')throw error('The game has already started.',409);const username=String(b.username||'').trim().replace(/[<>\x00-\x1f]/g,'').slice(0,18);if(!username)throw error('Enter a username.');if(r.players.length>=61)throw error('Room full.',409);if(r.players.some(p=>p.username.toLowerCase()===username.toLowerCase()))throw error('Username already taken.',409);const token=uid();r.players.push({token,username,host:false,score:0,found:new Set()});return json(res,200,{token,room:publicRoom(r)})}
const p=member(r,b.token);
if(action==='start'){if(!p.host)throw error('Only the teacher can start.',403);if(r.status!=='lobby')throw error('Already started.',409);r.status='playing';r.startedAt=Date.now();return json(res,200,{room:publicRoom(r)})}
if(action==='finish'){if(!p.host)throw error('Only the teacher can finish.',403);r.status='finished';return json(res,200,{room:publicRoom(r)})}
if(action==='word'){if(p.host)throw error('Host cannot score.',403);if(r.status!=='playing'||Date.now()-r.startedAt>=r.duration*1000)throw error('Round has ended.',409);const word=String(b.word||'').toLowerCase();if(!/^[a-z]{3,16}$/.test(word)||(!dictionary.has(word)&&!r.customWords.includes(word)))throw error('Not a recognised word.',422);if(!pathValid(word,b.path,r.board))throw error('Word must be traced on the board.',422);if(p.found.has(word))return json(res,200,{duplicate:true,room:publicRoom(r)});p.found.add(word);p.score+=word.length;r.discoveries.push({word,username:p.username});return json(res,200,{room:publicRoom(r)})}
throw error('Unknown action',404)
}catch(e){json(res,e.status||500,{error:e.message||'Server error'})}}
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8'};
http.createServer((req,res)=>{let url;try{url=new URL(req.url,'http://localhost')}catch{return json(res,400,{error:'Invalid URL'})}if(url.pathname.startsWith('/api/'))return api(req,res,url);if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});const target=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));if(!['index.html','game.js','dictionary.json'].includes(target))return json(res,404,{error:'Not found'});const file=path.join(ROOT,target);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});fs.createReadStream(file).pipe(res)}).listen(PORT,'0.0.0.0',()=>console.log('WordGrid running on port '+PORT));
setInterval(()=>{for(const [id,r] of rooms)if(Date.now()-r.createdAt>3*60*60*1000)rooms.delete(id)},600000).unref();
