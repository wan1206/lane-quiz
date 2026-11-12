# Lane Quiz Run

Live 3D quiz game for up to 50 players. Players join with a 4-digit code, no sign-in needed.

Run locally:   npm install   then   npm start   then open http://localhost:3000
Edit questions: questions.json  ({"q": question, "a": correct answer, "w": [3 wrong answers]})
Change players per game / seconds per question: MAXP and TL at the top of server.js
(if you change TL, also change TL in public/index.html).
