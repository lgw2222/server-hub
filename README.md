# Server Hub

Install this once. After that, every local app you build is just an address you paste in.

## First time
1. Install Node.js from nodejs.org (LTS).
2. Put this folder somewhere permanent, like `C:\server-hub` (not Downloads).
3. Double-click `start.bat`. Leave the window open.
4. It prints an address like `http://192.168.2.144:4000`. Open that on your phone and add it to your home screen.

## Adding an app
Upload the app's folder to GitHub Pages with your uploader, then paste its address into Add an app. Server Hub downloads it, gives it a port, and starts it.

Each app card has: Update, Start/Stop, Restart, Autostart, Log, Remove. Update downloads the newest files, deletes ones the app no longer uses, keeps its data files, and restarts it.

## Making an app work here
Put an `app.json` at the root of the app's repo:

```json
{
  "name": "TV Remote Hub",
  "slug": "tv-hub",
  "entry": "server.js",
  "port": 3000,
  "files": ["server.js", "package.json", "public/index.html"],
  "keep": ["tvs.json"]
}
```

- `files` is every file to download. Anything else in the app's folder gets cleaned out on update, so list them all.
- `keep` is data the app writes itself, never overwritten or deleted.
- `port` is a preference; Server Hub picks another if it's taken.
- The app reads its port from `process.env.PORT`.
- Apps can `require("express")` without installing it, since Server Hub shares its own copy.
- If an app exits with code 7, Server Hub restarts it. That's how an app can restart itself.

## Updating Server Hub
Upload this folder to Pages as its own site, paste that address in the Server Hub section, and use Update Server Hub. Old copies go to a `backup` folder.

Only paste addresses for repos you control. Server Hub runs whatever code it downloads.
