'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const dictionary = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'dictionary.json'), 'utf8')));
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const rooms = new Map();
const MAX_PLAYERS = 60;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const OXFORD_APP_ID = process.env.OXFORD_APP_ID || '';
const OXFORD_APP_KEY = process.env.OXFORD_APP_KEY || '';
const OXFORD_ENABLED = Boolean(OXFORD_APP_ID && OXFORD_APP_KEY);
const OXFORD_REQUIRED = process.env.OXFORD_REQUIRED !== 'false';

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 100_000) {
        reject(Object.assign(new Error('Request too large.'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function cleanName(value) {
  return String(value || '').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 18);
}
function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    duration: room.duration,
    selectedMode: room.selectedMode,
    listLabel: room.listLabel,
    onlySpellingWords: room.onlySpellingWords,
    minWordLength: room.minWordLength,
    gridLetters: room.gridLetters,
    wordBank: room.wordBank,
    seedWords: room.seedWords,
    startedAt: room.startedAt,
    players: [...room.players.values()].map(p => ({ username: p.username, role: p.role, score: p.score, foundWords: p.foundWords })),
    discoveries: room.discoveries.slice(-150)
  };
}
function findRoom(code) { return rooms.get(String(code || '').toUpperCase()); }
function validCode(code) { return /^[A-Z0-9]{4,8}$/.test(String(code || '').toUpperCase()); }
function hasBoardPath(word, letters) {
  if (!Array.isArray(letters) || letters.length !== 100) return false;
  const neighbours = index => {
    const r = Math.floor(index / 10), c = index % 10, out = [];
    for (let dr=-1; dr<=1; dr++) for (let dc=-1; dc<=1; dc++) {
      if (!dr && !dc) continue;
      const nr=r+dr, nc=c+dc;
      if (nr>=0 && nr<10 && nc>=0 && nc<10) out.push(nr*10+nc);
    }
    return out;
  };
  function visit(pos, offset, used) {
    if (offset === word.length) return true;
    for (const next of neighbours(pos)) {
      if (used.has(next) || letters[next] !== word[offset]) continue;
      used.add(next);
      if (visit(next, offset+1, used)) return true;
      used.delete(next);
    }
    return false;
  }
  for (let i=0; i<100; i++) if (letters[i] === word[0] && visit(i,1,new Set([i]))) return true;
  return false;
}
function serverError(res, err) { json(res, err.status || 500, { error: err.message || 'Server error.' }); }
function getPlayer(room, playerId) { return room && room.players.get(String(playerId || '')); }
async function isRecognisedEnglishWord(word) {
  if (OXFORD_REQUIRED && !OXFORD_ENABLED) {
    throw Object.assign(new Error('Oxford Dictionary verification is required but the server is missing OXFORD_APP_ID and OXFORD_APP_KEY.'), { status: 503 });
  }
  if (!OXFORD_ENABLED) return dictionary.has(word);
  let response;
  try {
    response = await fetch(`https://od-api.oxforddictionaries.com/api/v2/words/en-gb?q=${encodeURIComponent(word)}`, {
      headers: { app_id: OXFORD_APP_ID, app_key: OXFORD_APP_KEY, Accept: 'application/json' },
      signal: AbortSignal.timeout(7000)
    });
  } catch (err) {
    throw Object.assign(new Error('Oxford Dictionaries could not be reached. Please try the word again.'), { status: 503 });
  }
  if (response.status === 404) return false;
  if (!response.ok) {
    throw Object.assign(new Error(`Oxford Dictionaries returned a service error (${response.status}). Please try again.`), { status: 503 });
  }
  const payload = await response.json().catch(() => ({}));
  return Array.isArray(payload.results) && payload.results.length > 0;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, {
    ok: true, rooms: rooms.size, oxfordEnabled: OXFORD_ENABLED, oxfordRequired: OXFORD_REQUIRED,
    dictionaryProvider: OXFORD_ENABLED ? 'Oxford Dictionaries API · en-gb' : 'Bundled local word list (not Oxford-verified)'
  });

  if (pathname === '/api/validate-word' && req.method === 'POST') {
    try {
      const body = await readBody(req); const word = String(body.word || '').toLowerCase();
      if (!/^[a-z]{1,32}$/.test(word)) return json(res, 400, { error: 'Enter a single word using letters only.' });
      const valid = await isRecognisedEnglishWord(word);
      return json(res, 200, { valid, provider: OXFORD_ENABLED ? 'Oxford Dictionaries API · en-gb' : 'Bundled word list (not Oxford-verified)' });
    } catch (err) { return serverError(res, err); }
  }
  if (pathname === '/api/validate-list' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!Array.isArray(body.words) || body.words.length < 1 || body.words.length > 10) return json(res, 400, { error: 'Provide between 1 and 10 focus words.' });
      const words = [...new Set(body.words.map(w => String(w || '').toLowerCase()))];
      if (words.some(w => !/^[a-z]{1,16}$/.test(w))) return json(res, 400, { error: 'Focus words must use letters only and be no longer than 16 letters.' });
      const checks = await Promise.all(words.map(async word => ({ word, valid: await isRecognisedEnglishWord(word) })));
      return json(res, 200, { invalid: checks.filter(x => !x.valid).map(x => x.word), provider: OXFORD_ENABLED ? 'Oxford Dictionaries API · en-gb' : 'Bundled word list (not Oxford-verified)' });
    } catch (err) { return serverError(res, err); }
  }

  if (pathname === '/api/rooms' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const code = String(body.code || '').toUpperCase();
      const hostId = String(body.hostId || '');
      const duration = Number(body.duration);
      if (!validCode(code) || !hostId) return json(res, 400, { error: 'Invalid room code or host id.' });
      if (rooms.has(code)) return json(res, 409, { error: 'That room code is already in use. Please create the game again.' });
      if (!Array.isArray(body.gridLetters) || body.gridLetters.length !== 100 || body.gridLetters.some(x => !/^[a-z]$/i.test(String(x)))) return json(res, 400, { error: 'A valid 100-letter board is required.' });
      if (!Number.isFinite(duration) || duration < 30 || duration > 600) return json(res, 400, { error: 'Invalid round length.' });
      const selectedMode = String(body.selectedMode || 'random');
      if (!['random', 'year', 'custom'].includes(selectedMode)) return json(res, 400, { error: 'Invalid word-list selection.' });
      const onlySpellingWords = body.onlySpellingWords === true;
      const minWordLength = Number(body.minWordLength || 3);
      if (!Number.isInteger(minWordLength) || minWordLength < 3 || minWordLength > 6) return json(res, 400, { error: 'Minimum scoring word length must be between 3 and 6.' });
      const wordBank = Array.isArray(body.wordBank) ? body.wordBank.filter(w => /^[a-z]{1,16}$/i.test(String(w))).map(w => String(w).toLowerCase()).slice(0, 2000) : [];
      if (selectedMode === 'custom' && (!wordBank.length || wordBank.length > 10)) return json(res, 400, { error: 'A custom list must contain between 1 and 10 words.' });
      if (onlySpellingWords && selectedMode !== 'custom') return json(res, 400, { error: 'Spelling-only mode requires a custom spelling list.' });
      const hostName = cleanName(body.hostName || 'Teacher') || 'Teacher';
      const room = {
        code, hostId, status: 'lobby', duration,
        selectedMode: selectedMode.slice(0, 12),
        onlySpellingWords, minWordLength,
        listLabel: String(body.listLabel || 'Random words').slice(0, 80),
        gridLetters: body.gridLetters.map(x => String(x).toLowerCase()),
        wordBank,
        seedWords: Array.isArray(body.seedWords) ? body.seedWords.filter(w => /^[a-z]{1,16}$/i.test(String(w))).slice(0, 100) : [],
        players: new Map([[hostId, { id: hostId, username: hostName, role: 'host', score: 0, foundWords: [], joinedAt: Date.now() }]]),
        discoveries: [], startedAt: 0, createdAt: Date.now(), lastActivity: Date.now()
      };
      rooms.set(code, room);
      return json(res, 201, { room: publicRoom(room) });
    } catch (err) { return serverError(res, err); }
  }

  const match = pathname.match(/^\/api\/rooms\/([A-Z0-9]+)(?:\/(join|start|score|finish|replay|leave))?$/i);
  if (match) {
    const code = match[1].toUpperCase();
    const action = match[2] || '';
    let room = findRoom(code);
    if (req.method === 'GET' && !action) {
      if (!room) return json(res, 404, { error: 'Game not found. Check the code or ask your teacher to create a new game.' });
      room.lastActivity = Date.now();
      return json(res, 200, { room: publicRoom(room) });
    }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        if (action === 'join') {
          if (!room) return json(res, 404, { error: 'Game not found. Check the code on the board.' });
          const id = String(body.playerId || '');
          const username = cleanName(body.username);
          if (!id || !username) return json(res, 400, { error: 'Enter a username to join.' });
          const prior = room.players.get(id);
          if (room.status !== 'lobby' && !prior) return json(res, 409, { error: 'This game has already started. Ask your teacher to create a new round.' });
          const duplicate = [...room.players.values()].find(p => p.role !== 'host' && p.id !== id && p.username.toLowerCase() === username.toLowerCase());
          if (duplicate) return json(res, 409, { error: 'That username is already in use. Please choose another.' });
          if (!prior && room.players.size >= MAX_PLAYERS + 1) return json(res, 403, { error: 'This game has reached its player limit.' });
          room.players.set(id, { id, username, role: 'player', score: prior ? prior.score : 0, foundWords: prior ? prior.foundWords : [], joinedAt: prior ? prior.joinedAt : Date.now() });
          room.lastActivity = Date.now();
          return json(res, 200, { room: publicRoom(room) });
        }
        if (!room) return json(res, 404, { error: 'Game not found. It may have expired.' });
        const playerId = String(body.playerId || '');
        const player = getPlayer(room, playerId);
        if (!player) return json(res, 403, { error: 'You are not a member of this game.' });
        if (action === 'start') {
          if (player.role !== 'host' || room.hostId !== playerId) return json(res, 403, { error: 'Only the teacher who created the game can start it.' });
          if (room.status !== 'lobby') return json(res, 409, { error: 'This game has already started.' });
          room.status = 'playing'; room.startedAt = Date.now(); room.lastActivity = Date.now();
          return json(res, 200, { room: publicRoom(room) });
        }
        if (action === 'score') {
          if (player.role !== 'player') return json(res, 403, { error: 'Only pupils can submit words.' });
          if (room.status !== 'playing') return json(res, 409, { error: 'The round is not active.' });
          const word = String(body.word || '').toLowerCase();
          if (!/^[a-z]{1,16}$/.test(word)) return json(res, 400, { error: 'Invalid word.' });
          if (room.onlySpellingWords && !room.wordBank.includes(word)) return json(res, 422, { error: 'This round is spelling-only. Find one of the host’s focus spellings.' });
          if (word.length === 1 && !room.wordBank.includes(word)) return json(res, 422, { error: 'Single-letter words only count when they are in the selected focus list.' });
          const validWord = await isRecognisedEnglishWord(word);
          if (!validWord && !(word.length === 1 && room.wordBank.includes(word) && !OXFORD_ENABLED && !OXFORD_REQUIRED)) return json(res, 422, { error: OXFORD_ENABLED ? 'Oxford Dictionaries did not recognise that word.' : 'That word is not in the bundled game dictionary.' });
          if (!hasBoardPath(word, room.gridLetters)) return json(res, 422, { error: 'That word cannot be traced on this board.' });
          if (player.foundWords.includes(word)) return json(res, 200, { room: publicRoom(room), duplicate: true });
          const bonus = room.wordBank.includes(word);
          const belowMinimum = word.length < room.minWordLength;
          const points = belowMinimum ? 0 : word.length * (bonus ? 2 : 1);
          player.foundWords.push(word);
          player.score += points;
          room.discoveries.push({ playerId, username: player.username, word, points, bonus, belowMinimum, at: Date.now() });
          room.lastActivity = Date.now();
          return json(res, 200, { room: publicRoom(room), points, bonus, belowMinimum });
        }
        if (action === 'finish') {
          if (player.role !== 'host' || room.hostId !== playerId) return json(res, 403, { error: 'Only the teacher can finish the round.' });
          room.status = 'finished'; room.lastActivity = Date.now();
          return json(res, 200, { room: publicRoom(room) });
        }
        if (action === 'replay') {
          if (player.role !== 'host' || room.hostId !== playerId) return json(res, 403, { error: 'Only the teacher who created the game can prepare another round.' });
          if (room.status !== 'finished') return json(res, 409, { error: 'Finish the current round before preparing another one.' });
          const duration = Number(body.duration);
          if (!Number.isFinite(duration) || duration < 30 || duration > 600) return json(res, 400, { error: 'Invalid round length.' });
          if (!Array.isArray(body.gridLetters) || body.gridLetters.length !== 100 || body.gridLetters.some(x => !/^[a-z]$/i.test(String(x)))) return json(res, 400, { error: 'A valid 100-letter board is required.' });
          const selectedMode = String(body.selectedMode || 'random');
          if (!['random', 'year', 'custom'].includes(selectedMode)) return json(res, 400, { error: 'Invalid word-list selection.' });
          const wordBank = Array.isArray(body.wordBank) ? body.wordBank.filter(w => /^[a-z]{1,16}$/i.test(String(w))).map(w => String(w).toLowerCase()).slice(0, 2000) : [];
          const seedWords = Array.isArray(body.seedWords) ? body.seedWords.filter(w => /^[a-z]{1,16}$/i.test(String(w))).map(w => String(w).toLowerCase()).slice(0, 2000) : [];
          if (selectedMode === 'custom' && (!wordBank.length || wordBank.length > 10)) return json(res, 400, { error: 'A custom list must contain between 1 and 10 words.' });
          const onlySpellingWords = body.onlySpellingWords === true;
          const minWordLength = Number(body.minWordLength || 3);
          if (!Number.isInteger(minWordLength) || minWordLength < 3 || minWordLength > 6) return json(res, 400, { error: 'Minimum scoring word length must be between 3 and 6.' });
          if (onlySpellingWords && selectedMode !== 'custom') return json(res, 400, { error: 'Spelling-only mode requires a custom spelling list.' });
          const keepPlayers = body.keepPlayers === true;
          const host = room.players.get(room.hostId);
          const nextPlayers = new Map();
          if (keepPlayers) {
            for (const existing of room.players.values()) {
              nextPlayers.set(existing.id, { ...existing, score: 0, foundWords: [] });
            }
          } else if (host) {
            nextPlayers.set(host.id, { ...host, score: 0, foundWords: [] });
          }
          room.players = nextPlayers;
          room.duration = duration;
          room.selectedMode = selectedMode;
          room.onlySpellingWords = onlySpellingWords;
          room.minWordLength = minWordLength;
          room.listLabel = String(body.listLabel || 'Classroom word list').slice(0, 80);
          room.gridLetters = body.gridLetters.map(x => String(x).toLowerCase());
          room.wordBank = wordBank;
          room.seedWords = seedWords;
          room.discoveries = [];
          room.startedAt = 0;
          room.status = 'lobby';
          room.roundNumber = (Number(room.roundNumber) || 1) + 1;
          room.lastActivity = Date.now();
          return json(res, 200, { room: publicRoom(room) });
        }
        if (action === 'leave') {
          if (player.role === 'host') { room.status = 'finished'; room.lastActivity = Date.now(); }
          else room.players.delete(playerId);
          return json(res, 200, { ok: true });
        }
      } catch (err) { return serverError(res, err); }
    }
  }

  if (req.method !== 'GET' || pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
  let filePath = pathname === '/' ? path.join(ROOT, 'index.html') : path.join(ROOT, pathname.replace(/^\/+/, ''));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, 'index.html')) return json(res, 403, { error: 'Forbidden.' });
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) filePath = path.join(ROOT, 'index.html');
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(filePath).pipe(res);
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.lastActivity > ROOM_TTL_MS) rooms.delete(code);
}, 10 * 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => console.log(`WordGrid server listening on ${PORT}`));
