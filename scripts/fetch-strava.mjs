// scripts/fetch-strava.mjs
import fs from 'node:fs';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

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

  // Save any rotated refresh_token so CI can update the repo secret
  if (data.refresh_token && data.refresh_token !== STRAVA_REFRESH_TOKEN) {
    await fsp.mkdir('.data', { recursive: true });
    await fsp.writeFile('.data/rotated_refresh_token.txt', data.refresh_token, 'utf8');
    console.log('Detected rotated Strava refresh_token; wrote .data/rotated_refresh_token.txt');
  }

  return data.access_token;
}

// Choose best URL from Strava's photo sizes
function pickBestPhotoUrl(p) {
  if (!p) return null;
  const u = p.urls || {};
  return u['2048'] || u['1200'] || u['1000'] || p.url || null;
}

// Build display stats
function buildStats(activity) {
  const distanceKm = (activity.distance ?? 0) / 1000;
  const moving = activity.moving_time ?? activity.elapsed_time ?? 0;
  const type = activity.sport_type || activity.type;

  if ((type === 'Run' || type === 'TrailRun') && distanceKm > 0) {
    const paceSecPerKm = moving / distanceKm;
    const pm = Math.floor(paceSecPerKm / 60);
    const ps = Math.round(paceSecPerKm % 60);
    return {
      isRun: true,
      distance: `${distanceKm.toFixed(2)} km`,
      pace: `${pm}:${String(ps).padStart(2, '0')}/km`,
      duration: hms(moving),
    };
  }

  if ((type === 'Ride' || type === 'VirtualRide') && distanceKm > 0) {
    const hours = moving / 3600;
    const kph = hours > 0 ? distanceKm / hours : 0;
    return {
      isRun: false,
      distance: `${distanceKm.toFixed(2)} km`,
      speed: `${kph.toFixed(1)} km/h`,
      duration: hms(moving),
    };
  }

  return { isRun: false, duration: hms(moving) };
}

// Find the newest activity that truly has a photo — scan deep if needed
async function findLatestActivityWithPhoto(access) {
  const MAX_PAGES = 40;          // scan up to ~2000 activities
  const PER_PAGE  = 50;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const actsRes = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=${PER_PAGE}&page=${page}`,
      { headers: { Authorization: `Bearer ${access}` } }
    );
    if (!actsRes.ok) throw new Error(`Activities fetch failed: ${actsRes.status} – ${await actsRes.text()}`);
    const activities = await actsRes.json();
    if (!Array.isArray(activities) || activities.length === 0) break;

    // newest → oldest on each page
    for (const a of activities) {
      if ((a.total_photo_count ?? 0) <= 0) continue;

      // Try gallery photos first (highest res)
      try {
        const photosRes = await fetch(
          `https://www.strava.com/api/v3/activities/${a.id}/photos?size=2048`,
          { headers: { Authorization: `Bearer ${access}` } }
        );
        if (photosRes.ok) {
          const photos = await photosRes.json();
          if (Array.isArray(photos) && photos.length > 0) {
            const best = pickBestPhotoUrl(photos[0]);
            if (best) return { activity: a, photoUrl: best };
          }
        }
      } catch {}

      // Fallback: detailed activity cover photo (photos.primary)
      try {
        const actDetailRes = await fetch(
          `https://www.strava.com/api/v3/activities/${a.id}?include_all_efforts=false`,
          { headers: { Authorization: `Bearer ${access}` } }
        );
        if (actDetailRes.ok) {
          const detail = await actDetailRes.json();
          const best = pickBestPhotoUrl(detail?.photos?.primary);
          if (best) return { activity: a, photoUrl: best };
        }
      } catch {}
    }
  }
  return null;
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

async function run() {
  const access = await refreshAccessToken();

  // Find newest activity that has a photo attached
  const found = await findLatestActivityWithPhoto(access);

  // Fallback: no photo activities found → just use latest activity for stats
  if (!found) {
    const actsRes = await fetch(
      'https://www.strava.com/api/v3/athlete/activities?per_page=1',
      { headers: { Authorization: `Bearer ${access}` } }
    );
    if (!actsRes.ok) throw new Error(`Activities fetch failed: ${actsRes.status} – ${await actsRes.text()}`);
    const activities = await actsRes.json();
    const a = activities?.[0];
    if (!a) {
      writePayload({ error: 'No activities found', fetchedAt: new Date().toISOString() });
      return;
    }
    writePayload({
      athleteUrl: STRAVA_ATHLETE_ID ? `https://www.strava.com/athletes/${STRAVA_ATHLETE_ID}` : null,
      activityUrl: `https://www.strava.com/activities/${a.id}`,
      photoUrl: null,
      stats: buildStats(a),
      fetchedAt: new Date().toISOString(),
    });
    return;
  }

  // Compose payload with photo + stats
  const { activity: a, photoUrl } = found;
  writePayload({
    athleteUrl: STRAVA_ATHLETE_ID ? `https://www.strava.com/athletes/${STRAVA_ATHLETE_ID}` : null,
    activityUrl: `https://www.strava.com/activities/${a.id}`,
    photoUrl,
    stats: buildStats(a),
    fetchedAt: new Date().toISOString(),
  });
}

run().catch((e) => {
  console.error(e.message || e);
  // Write a fallback so the site still deploys
  writePayload({ error: String(e.message || e), fetchedAt: new Date().toISOString() });
  // keep build green
  // process.exit(1);
});
