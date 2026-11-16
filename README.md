# Social Media Manager

A private tool that watches your own and other accounts for outlier posts, reads the text on screen, and turns each outlier into a remix that lands in the Content Calendar. It supports several brands; each brand keeps its own accounts, outliers, patterns and remixes.

Built the same way as Content Calendar: React + Vite, Supabase for sign-in and data, GitHub Pages for hosting.

## How it fits together

- `src/main.jsx` is the app. `src/logic.js` holds the small pure helpers and `test/` covers them (`npm test`).
- `supabase/functions/smm/index.ts` is the server function. It runs the daily Instagram and Facebook sync, logs pasted links, and fetches cover images so the app can read their text.
- Database objects are all prefixed `smm_`. Remixes are written into the existing `cal_items` table, labelled with the brand, as one "to film" entry and one "post" entry. The Calendar tab shows that same table for every brand in one place.
- On-screen text is read in the browser with Tesseract.js. No paid service is involved.

## What works before Meta is connected

Brands, accounts, adding videos by link (TikTok details fill in automatically), reading text from screenshots and covers, patterns, remixes, and sending remixes to the calendar.

## Connecting Instagram and Facebook

The daily sync stays idle until three secrets are set on the `smm` function in Supabase (Edge Functions, Secrets):

- `META_ACCESS_TOKEN`: a user token from your Meta developer app with `instagram_basic`, `instagram_manage_insights`, `pages_show_list` and `pages_read_engagement`
- `META_APP_ID` and `META_APP_SECRET`: from the same app, so the token can be exchanged for Page tokens that do not expire

Then open Accounts and press "Sync now". The sync has not yet been run against live Meta data, so expect a round of fixes the first time it is connected.

## Develop

    npm install
    npm run dev
    npm test
    npm run build
