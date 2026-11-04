# WordGrid - A Mr Robinson Game

## Local standalone (no server needed)
Open `WordGrid-LOCAL.html` in a modern browser. This works offline for single-player games (random Years 1–6, selected Year 1–6, or up to ten custom words). The local file is not multiplayer; it cannot share scores or rooms with other devices.

## Web-based classroom multiplayer
The `wordgrid_web` folder is a Node.js app. Install Node.js 20 or later, open a terminal in this folder and run `npm start`. Open `http://localhost:3000` on the host computer. For public QR-code joining, deploy the same folder to a Node.js hosting service (e.g. Replit or Render) with start command `npm start`. Do not use static-only hosting. Use the public HTTPS address to host a room and display its QR code. Pupils scan, choose a nickname, join, and wait for the teacher to start. The teacher sees live player scores and discovered words.

The web app has no npm dependencies and requires no database for temporary rooms. Rooms are stored in server memory and disappear on restart or after three hours. Use one running server instance. A public domain is not included; publishing requires a hosting account. QR images are requested from api.qrserver.com; the room code is available if the QR service is blocked. Ask pupils to use nicknames, not full names. Before school use, review your school's safeguarding, privacy and hosting requirements. The game has not undergone a formal security audit and should not be treated as production-hardened.

## Contents
- `index.html`: web interface
- `game.js`: gameplay and client-side room controls
- `dictionary.json`: bundled English dictionary
- `server.js`: server-side rooms, validation and scores
- `package.json`: Node.js startup
