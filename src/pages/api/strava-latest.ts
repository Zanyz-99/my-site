import type { APIRoute } from 'astro';

const TOKEN_URL = 'https://www.strava.com/api/v3/oauth/token';

async function getAccessToken() {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: import.meta.env.STRAVA_CLIENT_ID,
      client_secret: import.meta.env.STRAVA_CLIENT_SECRET,
      refresh_token: import.meta.env.STRAVA_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Token refresh failed: ${t}`);
  }
  const data = await res.json();
  return data.access_token as string;
}

function hms(totalSeconds: number) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.round(totalSeconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

export const GET: APIRoute = async () => {
  try {
    const access = await getAccessToken();

    // 1) Recent activities
    const actsRes = await fetch(
      'https://www.strava.com/api/v3/athlete/activities?per_page=10',
      { headers: { Authorization: `Bearer ${access}` } }
    );
    if (!actsRes.ok) throw new Error(`Activities fetch failed`);
    const activities = await actsRes.json();

    const picked =
      activities.find((a: any) => (a.total_photo_count ?? 0) > 0) ||
      activities[0];

    if (!picked) {
      return new Response(JSON.stringify({}), { status: 204 });
    }

    // 2) Pull first photo
    let photoUrl: string | null = null;
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
    } catch {
      /* ignore */
    }

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
              pace: `${pm}:${String(ps).padStart(2,'0')}/km`,
              duration: hms(durationSec),
            };
          })()
        : { isRun: false, duration: hms(durationSec) };

    return new Response(
      JSON.stringify({
        photoUrl,
        stats,
        activityUrl: `https://www.strava.com/activities/${picked.id}`,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          // small cache to keep it snappy but fresh
          'Cache-Control': 'public, max-age=120',
        },
      }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
