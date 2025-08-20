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
  return data.access_token;
}

async function run() {
  const access = await refreshAccessToken();

  // 1) Get recent activities
  const actsRes = await fetch(
    'https://www.strava.com/api/v3/athlete/activities?per_page=10',
    { headers: { Authorization: `Bearer ${access}` } }
  );
  if (!actsRes.ok) throw new Error(`Activities fetch failed: ${actsRes.status}`);
  const activities = await actsRes.json();

  const picked =
    activities.find((a) => (a.total_photo_count ?? 0) > 0) || activities[0];

  if (!picked) {
    console.log('No activities found');
    return;
  }

  // 2) First photo, good size
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
    }
  } catch {}

  // 3) Stats
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

  const payload = {
    athleteUrl: STRAVA_ATHLETE_ID
      ? `https://www.strava.com/athletes/${STRAVA_ATHLETE_ID}`
      : null,
    activityUrl: `https://www.strava.com/activities/${picked.id}`,
    photoUrl,
    stats,
    fetchedAt: new Date().toISOString(),
  };

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
  console.error(e);
  process.exit(1);
});
