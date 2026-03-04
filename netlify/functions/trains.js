// netlify/functions/trains.js

const FEED_URL       = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr";
const STATION_NAME   = "Port Chester";
const STOP_ID        = "115";
const GCT_STOP_ID    = "1";
const WALK_MINUTES   = 10;
const BUFFER_MINUTES = 2;

class PBReader {
  constructor(buf) {
    this.b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.pos = 0;
    this.end = this.b.length;
  }
  varint() {
    let lo = 0, shift = 0, b;
    do {
      b = this.b[this.pos++];
      lo |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80 && shift < 49);
    return lo >>> 0;
  }
  skip(wt) {
    if (wt === 0) this.varint();
    else if (wt === 1) this.pos += 8;
    else if (wt === 2) this.pos += this.varint();
    else if (wt === 5) this.pos += 4;
  }
  str(len) {
    const s = new TextDecoder().decode(this.b.slice(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  msg(len, cb) {
    const end = this.pos + len;
    const saved = this.end;
    this.end = end;
    while (this.pos < end) {
      const tag = this.varint();
      cb(tag >>> 3, tag & 7);
    }
    this.pos = end;
    this.end = saved;
  }
}

function parseGtfsRt(buffer) {
  const r = new PBReader(buffer);
  const now = Math.floor(Date.now() / 1000);
  const trains = [];

  r.msg(r.b.length, (f, wt) => {
    if (f !== 2 || wt !== 2) { r.skip(wt); return; }

    r.msg(r.varint(), (f2, wt2) => {
      if (f2 !== 3 || wt2 !== 2) { r.skip(wt2); return; }

      let tripId = "", routeId = "";
      const stops = [];

      r.msg(r.varint(), (f3, wt3) => {
        if (f3 === 1 && wt3 === 2) {
          r.msg(r.varint(), (f4, wt4) => {
            if (f4 === 1 && wt4 === 2)      { const n = r.varint(); tripId  = r.str(n); }
            else if (f4 === 5 && wt4 === 2) { const n = r.varint(); routeId = r.str(n); }
            else r.skip(wt4);
          });
        } else if (f3 === 2 && wt3 === 2) {
          let stopId = "", arrTs = 0, depTs = 0;
          r.msg(r.varint(), (f4, wt4) => {
            if (f4 === 4 && wt4 === 2) {
              const n = r.varint(); stopId = r.str(n);
            } else if (f4 === 2 && wt4 === 2) {
              r.msg(r.varint(), (f5, wt5) => {
                if (f5 === 2 && wt5 === 0) arrTs = r.varint(); else r.skip(wt5);
              });
            } else if (f4 === 3 && wt4 === 2) {
              r.msg(r.varint(), (f5, wt5) => {
                if (f5 === 2 && wt5 === 0) depTs = r.varint(); else r.skip(wt5);
              });
            } else r.skip(wt4);
          });
          stops.push({ stopId, arrTs, depTs });
        } else r.skip(wt3);
      });

      if (!stops.length) return;
      if (stops[stops.length - 1].stopId !== GCT_STOP_ID) return;

      const pcIdx = stops.findIndex(s => s.stopId === STOP_ID);
      if (pcIdx < 0) return;

      const pc = stops[pcIdx];
      const depTs = pc.depTs || pc.arrTs;
      if (!depTs) return;

      const gctArr = stops[stops.length - 1].arrTs || null;
      const lvTs = depTs - (WALK_MINUTES + BUFFER_MINUTES) * 60;

      trains.push({
        trip_id:          tripId,
        route_id:         routeId,
        dep_ts:           depTs,
        dep_time:         fmtTime(depTs),
        leave_ts:         lvTs,
        leave_time:       fmtTime(lvTs),
        leave_in_seconds: lvTs - now,
        gct_arr_ts:       gctArr,
        gct_arr_time:     gctArr ? fmtTime(gctArr) : null,
        stops_remaining:  stops.length - pcIdx,
      });
    });
  });

  trains.sort((a, b) => a.dep_ts - b.dep_ts);
  return trains;
}

function fmtTime(ts) {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  let h = d.getHours(), m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

export default async () => {
  try {
    const resp = await fetch(FEED_URL);
    if (!resp.ok) throw new Error(`MTA feed returned ${resp.status}`);
    const trains = parseGtfsRt(await resp.arrayBuffer());
    return new Response(JSON.stringify({
      status:         "ok",
      station:        STATION_NAME,
      stop_id:        STOP_ID,
      walk_minutes:   WALK_MINUTES,
      buffer_minutes: BUFFER_MINUTES,
      trains,
      updated:        new Date().toISOString(),
    }), {
      status: 200,
      headers: {
        "Content-Type":                "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control":               "no-store",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ status: "error", message: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = { path: "/api/trains" };
