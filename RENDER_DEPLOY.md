# Emergency hosted deployment for the company demo

Render runs the Docker container on its own infrastructure, so the laptop can
be turned off after deployment. The free service sleeps after inactivity and
may take about a minute to wake, but MongoDB keeps completed data and reports.

## Accounts needed

1. A GitHub account containing a private repository for this project.
2. A Render account connected to that GitHub account.
3. The existing MongoDB Atlas database.

Never commit `.env`. Render receives each secret through its encrypted
environment-variable form.

## Deploy

1. Push this project to a private GitHub repository.
2. In Render choose **New > Blueprint** and select the repository.
3. Render detects `render.yaml` and requests the secret values.
4. Enter `APP_PASSWORD`, `MONGODB_URI`, `OPENROUTER_API_KEY`,
   `OPENROUTER_MODEL`, and optionally `GEMINI_API_KEY`.
5. Deploy and wait for `/api/health` to become healthy.

The username defaults to `admin`. Use a new long password for `APP_PASSWORD`.

## MongoDB network access

Atlas must accept connections from the Render service. Prefer adding the
service's outbound IP ranges from Render's **Connect > Outbound** page to the
Atlas IP access list. For an emergency demo, Atlas can temporarily allow
`0.0.0.0/0`, provided the database user has a strong unique password; replace
that broad rule with Render's actual outbound ranges afterward.

## Demo preparation

1. Open the `onrender.com` URL at least five minutes before presenting.
2. Enter the application username and password.
3. Run one small source first with `maxPages=1` and fewer detail pages.
4. Confirm `/api/storage` says `mongodb`.
5. Keep the service page open during the demo so the free service remains warm.

The free instance has limited memory. Use it to demonstrate the workflow and
small/medium scrapes. A 2 GB paid instance or an on-demand cloud job is required
for reliable multi-thousand-property production runs.
