# IZIKI — Demo submissions

The demo inbox for **IZIKI**, an Afro house and Afro tech house label.

- Artists send unreleased music through the page at **izikiglobal.github.io/demos**.
- Every demo lands in a Google Sheet and **izikiteam@gmail.com** gets an email alert.
- The artist gets a confirmation email.
- **Danielle and Mikkas** listen and rate each track's **IZIKI fit (1–5 stars)** in a private Listening Room.
- On the **1st of every month**, the best-rated demo of the previous month is picked and emailed to the team.

```
GitHub Pages (index.html)  ──POST──▶  Google Apps Script  ──▶  Google Sheet
                                              ├──▶  alert email to izikiteam@gmail.com
                                              ├──▶  confirmation email to the artist
                                              ├──▶  Listening Room (private links)
                                              └──▶  Demo of the month (1st of each month)
```

## What's in the repo

| File | What it is |
|---|---|
| `index.html` | The submission page |
| `img/` | Papa Legba artwork and the social share image |
| `apps-script/Code.gs` | The backend: form handling, emails, ratings, monthly pick |
| `room.html` | The Listening Room (private links only) |
| `apps-script/Room.html` | Backup copy of the Listening Room served by Apps Script |

## The Google Sheet

| Tab | What it holds |
|---|---|
| **Demos** | One row per submission. Status, average IZIKI fit, all artist details, internal notes |
| **Ratings** | One row per track per listener: stars and comment |
| **Demo of the month** | The winner of each month |

## Set up (one time)

Use the **izikiteam@gmail.com** Google account.

1. Create a Google Sheet called **IZIKI Demos**.
2. **Extensions → Apps Script.** Replace the contents of `Code.gs` with `apps-script/Code.gs`.
3. Add an HTML file named **Room** (`+` → HTML) and paste in `apps-script/Room.html`.
4. Select the function **`setup`** and press **Run**. Approve the permissions.
   This creates the three tabs and the monthly trigger.
5. **Deploy → New deployment → Web app.** *Execute as:* **Me**. *Who has access:* **Anyone**. Copy the URL.
6. Paste that URL into `index.html` in place of `PASTE_YOUR_APPS_SCRIPT_URL_HERE`.
7. Run **`sendRoomLinks`**. Danielle and Mikkas each get a private Listening Room link by email. Bookmark it.

> When you change the code later, use **Deploy → Manage deployments → Edit → New version**
> so the URL stays the same.

## The Listening Room

- **To rate:** tracks you haven't rated yet. Each track plays right on the page (SoundCloud, Google Drive, direct audio files) or opens in a new tab.
- **IZIKI fit:** tap 1–5 stars, add a comment if you like. You see the other person's score only after you've rated, so you don't influence each other.
- **Decision:** Listening, Shortlist, Offer sent, Signed or Pass. Written straight into the sheet.
- **Demo of the month:** live ranking for the current month and final rankings for past months.
  Tracks rated by both of you rank first, then by average stars.

The links contain a secret key. Keep them inside the team.

## Built-in protections
- Required fields are checked on the page *and* on the server.
- Hidden honeypot field stops most spam bots.
- One submission per email every 30 days (`MIN_DAYS_BETWEEN` in the script).
- Only Afro house and Afro tech house can be selected as style.
- Artists must confirm no AI was used to make the music (AI-made tracks are not accepted).
- Text starting with `=`, `+`, `-` or `@` is escaped so nobody can inject sheet formulas.
- Artists must confirm the music is theirs and agree to their data being stored (GDPR).
