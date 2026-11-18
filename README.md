# WordGrid — Mr Robinson’s Game (local British English edition)

## Deploy to Render

Upload all project files to your existing Render Node web service and deploy. Build command: `npm install` (or leave empty). Start command: `npm start`. No dictionary API account, credentials or environment variables are needed. `PORT` is automatically supplied by Render.

## Dictionary

`dictionary.json` is a bundled, conservatively filtered classroom word list. It is not an authoritative or exhaustive British English dictionary. It was assembled by filtering the prior mixed vocabulary using locally available English lexical/frequency resources, excluding common abbreviations, names and American-only variants, and adding British spellings. This heuristic can reject legitimate uncommon words or admit some undesirable entries. Teachers can edit `dictionary.json` to adjust the list; the same list is embedded in `index.html` for solo checking.

Teachers may supply their own focus spelling words even if they are absent from the general dictionary. This is intentional for classroom use. The host can turn on spelling-only mode to accept only those focus words. The 3–6-letter minimum applies to scoring, not to recognition. Shorter valid words earn zero points.

## Testing

Run `npm start` and open http://localhost:3000. Health: `/api/health`. The Node server stores multiplayer rooms in memory, so restarting the service resets active rooms. No external dictionary requests are made.
