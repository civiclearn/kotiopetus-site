# kotiopetus.com

Static front end for the Kotiopetus tracker. Talks directly to Supabase (project `htgliokekeaovdiafrgs`, tables `ks_*`) from the browser with the anon key; all access is enforced by row-level security.

## Deploy (Cloudflare, Git flow)
1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → **Import a repository** → pick this repo.
   - Build command: leave empty. Deploy command: `npx wrangler deploy`.
3. Add custom domain `kotiopetus.com` under the Worker → Settings → Domains & Routes.
4. Every later push deploys automatically.

## Local preview
`npx wrangler dev` (or just open `public/index.html` — it is a plain static page).

## Files
- `public/index.html` — app shell (login, dashboard, subject table, topic drawer)
- `public/app.js` — all logic (vanilla JS + supabase-js UMD from cdnjs)
- `public/i18n.js` — fi / en strings
- `public/styles.css`
