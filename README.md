# eFootball Arena

Tournament system with server-side database (`database.json`), admin-verified payments, and player registration.

## Run the system

```bash
cd /path/to/RAXY
npm install
npm start
```

Open **http://localhost:3000** in your browser (do not open `index.html` as a `file://` URL).

## First-time setup

1. Click **ADMIN** → create your admin password (stored hashed in `database.json`).
2. Set **Payment Numbers** (M-Pesa ID `987465`, Tigo, Airtel, registration fee).
3. Players click **REGISTER**, pay to your number, submit payment reference.
4. Admin verifies under **Pending Registrations** → player can **LOGIN** with squad name + password.

## Data files

| File / folder      | Purpose                                      |
|--------------------|----------------------------------------------|
| `database.json`    | All squads, passwords (hashed), payments, game state |
| `images/`          | Welcome screen rotating photos (`img1.jpeg` …) |
| `uploads/`         | Player profile pictures (created on register) |

## Notes

- No trial squads are seeded — only registered & verified players appear.
- Admin password is **not** in source code; it lives in `database.json` as a bcrypt hash.
- Back up `database.json` and `uploads/` regularly.
# FEARLESSME
