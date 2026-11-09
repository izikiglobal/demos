# IZIKI — Demo submissions

The demo inbox for **IZIKI**, a house label. Artists send unreleased music through a
branded page; every demo lands in a Google Sheet, the label gets an email alert, and the
artist gets a confirmation.

```
GitHub Pages (index.html)  ──POST──▶  Google Apps Script  ──▶  Google Sheet "Demos"
                                              ├──▶  alert email to the label
                                              └──▶  confirmation email to the artist
```

Same setup as the District 909 DJ applications, except the form lives here in the repo,
so the page is easy to edit.

## What's in the repo

| File | What it is |
|---|---|
| `index.html` | The submission page (IZIKI branding, Papa Legba artwork) |
| `img/` | Hero artwork and the social share image |
| `apps-script/Code.gs` | The backend: paste it into Apps Script |

## Set up (about 10 minutes)

### 1. Create the sheet and backend
1. Create a new Google Sheet called **IZIKI Demos**.
2. In the sheet: **Extensions → Apps Script**. Delete what's there and paste in `apps-script/Code.gs`.
3. At the top of the script, set `NOTIFY_EMAIL` and `REPLY_TO` to the label's email.
4. Pick the function **`setupSheet`** in the toolbar and press **Run**. Approve the permissions.
   This creates the `Demos` tab with headers, a Status dropdown and a star rating column.
5. Optional: run **`testSubmission`** to check that a row appears and both emails arrive.
   Delete the test row afterwards.

### 2. Publish the backend
1. **Deploy → New deployment → Web app**.
2. *Execute as:* **Me**. *Who has access:* **Anyone**.
3. Copy the **Web app URL** (ends in `/exec`).

### 3. Connect the page
1. In `index.html`, replace `PASTE_YOUR_APPS_SCRIPT_URL_HERE` with that URL.
2. In the footer, replace `demos@iziki.example` with the real contact email.
3. Commit and push.

### 4. Turn on GitHub Pages
**Settings → Pages → Build and deployment → Deploy from a branch → `main` / root.**
The page will be live at `https://<owner>.github.io/<repo>/`.

> When you change `Code.gs` later, use **Deploy → Manage deployments → Edit → New version**
> so the URL stays the same.

## Working through demos

Everything happens in the sheet:

- **Status:** New → Listening → Shortlist → Offer sent → Signed / Pass (colour-coded)
- **Rating:** 1–5 stars
- **Internal notes:** for the team; artists never see this
- Filter by Style or Status to build listening sessions.

## Built-in protections
- Required fields are checked on the page *and* on the server.
- Hidden honeypot field stops most spam bots.
- One submission per email every 30 days (`MIN_DAYS_BETWEEN` in the script).
- Text starting with `=`, `+`, `-` or `@` is escaped so nobody can inject sheet formulas.
- Artists must confirm the music is theirs and agree to their data being stored (GDPR).
