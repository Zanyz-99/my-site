// scripts/fetch-strava.mjs
import fs from 'node:fs';
import path from 'node:path';

const {
  STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET,
  STRAVA_REFRESH_TOKEN,
  STRAVA_ATHLETE_ID,
} = process.env;

if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET || !STRAVA_REFRESH_TOKEN) {
  console.error('Missing Strava env vars');
  process.exit(1);
}

const TOKEN_URL = 'https://www.strava.com/api/v3/oauth/token';

const hms = (totalSeconds) => {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.round(totalSeconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
};

async function refreshAccessToken() {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      refresh_token: STRAVA_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  const data = await res.json();

  // ⚠️ Strava may rotate refresh tokens. We can't update GH secrets automatically here,
  // but we log a hint so you know to refresh it manually if needed.
  if (data.refresh_token && data.refresh_token !== STRAVA_REFRESH_TOKEN) {
    console.log('Note: Strava returned a new refresh_token. Update your repo secret to keep this working long-term.');
    // If you want to automate this, see section C below.
  }

  return data.access_token;
}

async function run() {
  const access = await refreshAccessToken();

  const actsRes = await fetch(
    'https://www.strava.com/api/v3/athlete/activities?per_page=10',
    { headers: { Authorization: `Bearer ${access}` } }
  );
  if (!actsRes.ok) {
    const body = await actsRes.text();
    throw new Error(`Activities fetch failed: ${actsRes.status} – ${body}`);
  }
  const activities = await actsRes.json();

  const picked =
    activities.find((a) => (a.total_photo_count ?? 0) > 0) || activities[0];

  if (!picked) {
    console.log('No activities found');
    writePayload({ error: 'No activities found' });
    return;
  }

  let photoUrl = null;
  try {
    const photosRes = await fetch(
      `https://www.strava.com/api/v3/activities/${picked.id}/photos?size=1200`,
      { headers: { Authorization: `Bearer ${access}` } }
    );
    if (photosRes.ok) {
      const photos = await photosRes.json();
      if (Array.isArray(photos) && photos.length > 0) {
        const p = photos[0];
        photoUrl =
          p?.urls?.['1200'] ||
          p?.urls?.['1000'] ||
          p?.urls?.['2048'] ||
          p?.url ||
          null;
      }
    } else {
      console.log('Photo fetch failed:', photosRes.status, await photosRes.text());
    }
  } catch (e) {
    console.log('Photo fetch error:', e.message);
  }

  const distanceKm = (picked.distance ?? 0) / 1000;
  const durationSec = picked.moving_time ?? picked.elapsed_time ?? 0;
  const isRun = picked.type === 'Run' || picked.type === 'TrailRun';

  const stats =
    isRun && distanceKm > 0
      ? (() => {
          const paceSecPerKm = durationSec / distanceKm;
          const pm = Math.floor(paceSecPerKm / 60);
          const ps = Math.round(paceSecPerKm % 60);
          return {
            isRun: true,
            distance: `${distanceKm.toFixed(2)} km`,
            pace: `${pm}:${String(ps).padStart(2, '0')}/km`,
            duration: hms(durationSec),
          };
        })()
      : { isRun: false, duration: hms(durationSec) };

  writePayload({
    athleteUrl: STRAVA_ATHLETE_ID
      ? `https://www.strava.com/athletes/${STRAVA_ATHLETE_ID}`
      : null,
    activityUrl: `https://www.strava.com/activities/${picked.id}`,
    photoUrl,
    stats,
    fetchedAt: new Date().toISOString(),
  });
}

function writePayload(payload) {
  const outDir = path.join('public', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'strava-latest.json'),
    JSON.stringify(payload, null, 2),
    'utf8'
  );
  console.log('Wrote public/data/strava-latest.json');
}

run().catch((e) => {
  console.error(e.message || e);
  // Write a fallback so the site still deploys
  writePayload({ error: String(e.message || e), fetchedAt: new Date().toISOString() });
  // Do NOT exit non-zero so deploy continues:
  // process.exit(1);
});
