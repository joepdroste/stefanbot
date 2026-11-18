<img src="assets/icon.svg" width="64" height="64" alt="">

# stefanbot

Song guessing for Discord: hear a 0.1s clip, guess the song, and every skip or miss reveals more (0.5s, 2s, 8s, 15s). Clips are Deezer 30s previews.

- `/play [genre] [voice] [playlist]` starts a round in the channel; with `voice:true` the bot plays the clips in your voice channel. `playlist` takes a Spotify, YouTube or Deezer playlist link; its songs are looked up on Deezer for the clips (YouTube imports need yt-dlp). Anyone guesses with `/guess`, first right answer scores 5 to 1 points.
- `/daily [song]` is one song per server per day, played privately, with a shareable result grid and streaks.
- `/leaderboard` shows the server's points.
- The Activity (launch it from a voice call) has the same Daily and Endless modes in a web UI, and shows everyone's progress.

## Run

Needs Node 26+ and ffmpeg on PATH.

```sh
npm install
cp .env.example .env   # fill in the Discord app's token, client id, client secret and a port
npm run build          # Activity web page into dist/
npm start
```

In the Discord Developer Portal: enable Activities, set the Activity URL mapping `/` to the public host that proxies to `PORT`, and add `https://127.0.0.1` as an OAuth2 redirect. Invite the bot with the `bot` and `applications.commands` scopes.

`npm test` runs the game logic tests, `npm run check` type checks.
