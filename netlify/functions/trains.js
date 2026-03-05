// netlify/functions/trains.js
// GTFS-RT field layout (confirmed from protobuf descriptor):
// StopTimeUpdate: field 1=stop_sequence, field 2=arrival, field 3=departure, field 4=stop_id
// StopTimeEvent:  field 1=delay, field 2=time, field 3=uncertainty
// TripUpdate:     field 1=trip, field 2=stop_time_update (repeated)
// TripDescriptor: field 1=trip_id, field 3=route_id
// FeedMessage:    field 1=header, field 2=entity (repeated)
// FeedEntity:     field 1=id, field 2=is_deleted, field 3=trip_update

const FEED_URL       = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr";
const WALK_MINUTES   = 10;
const BUFFER_MINUTES = 2;

// Complete Metro-North station list from GTFS stops.txt
const STATIONS = {
  // Grand Central
  "1":   "Grand Central",

  // Hudson Line
  "4":   "Harlem-125 St",
  "9":   "Morris Heights",
  "10":  "University Heights",
  "11":  "Marble Hill",
  "14":  "Spuyten Duyvil",
  "16":  "Riverdale",
  "17":  "Ludlow",
  "18":  "Yonkers",
  "19":  "Glenwood",
  "20":  "Greystone",
  "22":  "Hastings-on-Hudson",
  "23":  "Dobbs Ferry",
  "24":  "Ardsley-on-Hudson",
  "25":  "Irvington",
  "27":  "Tarrytown",
  "29":  "Philipse Manor",
  "30":  "Scarborough",
  "31":  "Ossining",
  "33":  "Croton-Harmon",
  "37":  "Cortlandt",
  "39":  "Peekskill",
  "40":  "Manitou",
  "42":  "Garrison",
  "43":  "Cold Spring",
  "44":  "Breakneck Ridge",
  "46":  "Beacon",
  "49":  "New Hamburg",
  "51":  "Poughkeepsie",

  // Harlem Line
  "54":  "Melrose",
  "55":  "Tremont",
  "56":  "Fordham",
  "57":  "Botanical Garden",
  "58":  "Williams Bridge",
  "59":  "Woodlawn",
  "61":  "Wakefield",
  "62":  "Mt Vernon West",
  "64":  "Fleetwood",
  "65":  "Bronxville",
  "66":  "Tuckahoe",
  "68":  "Crestwood",
  "71":  "Scarsdale",
  "72":  "Hartsdale",
  "74":  "White Plains",
  "76":  "North White Plains",
  "78":  "Valhalla",
  "79":  "Mt Pleasant",
  "80":  "Hawthorne",
  "81":  "Pleasantville",
  "83":  "Chappaqua",
  "84":  "Mt Kisco",
  "85":  "Bedford Hills",
  "86":  "Katonah",
  "88":  "Goldens Bridge",
  "89":  "Purdy's",
  "90":  "Croton Falls",
  "91":  "Brewster",
  "94":  "Southeast",
  "97":  "Patterson",
  "98":  "Pawling",
  "99":  "Appalachian Trail",
  "100": "Harlem Valley-Wingdale",
  "101": "Dover Plains",
  "176": "Tenmile River",
  "177": "Wassaic",

  // New Haven Line (Main)
  "105": "Mt Vernon East",
  "106": "Pelham",
  "108": "New Rochelle",
  "110": "Larchmont",
  "111": "Mamaroneck",
  "112": "Harrison",
  "114": "Rye",
  "115": "Port Chester",
  "116": "Greenwich",
  "118": "Cos Cob",
  "120": "Riverside",
  "121": "Old Greenwich",
  "124": "Stamford",
  "127": "Noroton Heights",
  "128": "Darien",
  "129": "Rowayton",
  "131": "South Norwalk",
  "133": "East Norwalk",
  "134": "Westport",
  "136": "Green's Farms",
  "137": "Southport",
  "138": "Fairfield",
  "188": "Fairfield-Black Rock",
  "140": "Bridgeport",
  "143": "Stratford",
  "145": "Milford",
  "190": "West Haven",
  "149": "New Haven",
  "151": "New Haven-State St",

  // New Canaan Branch
  "153": "Glenbrook",
  "154": "Springdale",
  "155": "Talmadge Hill",
  "157": "New Canaan",

  // Danbury Branch
  "158": "Merritt 7",
  "160": "Wilton",
  "161": "Cannondale",
  "162": "Branchville",
  "163": "Redding",
  "164": "Bethel",
  "165": "Danbury",

  // Waterbury Branch
  "167": "Derby-Shelton",
  "168": "Ansonia",
  "169": "Seymour",
  "170": "Beacon Falls",
  "171": "Naugatuck",
  "172": "Waterbury",
};

// Reverse lookup: name -> id
const STATION_IDS = Object.fromEntries(
  Object.entries(STATIONS).map(([id, name]) => [name.toLowerCase(), id])
);

const td = new TextDecoder();

function varint(u8, pos) {
  let val = 0, shift = 0, b;
  do { b = u8[pos++]; val |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  return [val >>> 0, pos];
}

function scanMsg(u8, start, end) {
  const fields = {};
  let pos = start;
  while (pos < end) {
    if (pos >= u8.length) break;
    const [tag, p1] = varint(u8, pos);
    pos = p1;
    const f = tag >>> 3;
    const wt = tag & 7;
    if (wt === 0) {
      const [val, p2] = varint(u8, pos);
      pos = p2;
      if (!fields[f]) fields[f] = [];
      fields[f].push(val);
    } else if (wt === 1) {
      pos += 8;
    } else if (wt === 2) {
      const [len, p2] = varint(u8, pos);
      pos = p2;
      if (!fields[f]) fields[f] = [];
      fields[f].push({ pos: p2, len });
      pos = p2 + len;
    } else if (wt === 5) {
      pos += 4;
    } else {
      break;
    }
  }
  return fields;
}

function str(u8, ref) {
  return td.decode(u8.slice(ref.pos, ref.pos + ref.len));
}

function scalarIn(u8, ref, fieldNum) {
  const inner = scanMsg(u8, ref.pos, ref.pos + ref.len);
  if (!inner[fieldNum] || !inner[fieldNum].length) return 0;
  const v = inner[fieldNum][0];
  return typeof v === 'number' ? v : 0;
}

function parseGtfsRt(buffer, fromId, toId) {
  const u8   = new Uint8Array(buffer);
  const now  = Math.floor(Date.now() / 1000);
  const root = scanMsg(u8, 0, u8.length);
  const trains = [];

  for (const entityRef of (root[2] || [])) {
    if (typeof entityRef !== 'object') continue;
    const entity = scanMsg(u8, entityRef.pos, entityRef.pos + entityRef.len);

    if (!entity[3] || !entity[3][0] || typeof entity[3][0] !== 'object') continue;
    const tuRef = entity[3][0];
    const tu    = scanMsg(u8, tuRef.pos, tuRef.pos + tuRef.len);

    let tripId = "", routeId = "";
    if (tu[1] && typeof tu[1][0] === 'object') {
      const trip = scanMsg(u8, tu[1][0].pos, tu[1][0].pos + tu[1][0].len);
      if (trip[1] && typeof trip[1][0] === 'object') tripId  = str(u8, trip[1][0]);
      if (trip[5] && typeof trip[5][0] === 'object') routeId = str(u8, trip[5][0]);
    }

    const stops = [];
    for (const stuRef of (tu[2] || [])) {
      if (typeof stuRef !== 'object') continue;
      const stu = scanMsg(u8, stuRef.pos, stuRef.pos + stuRef.len);

      let stopId = "";
      if (stu[4] && typeof stu[4][0] === 'object') stopId = str(u8, stu[4][0]);

      const arrTs = (stu[2] && typeof stu[2][0] === 'object') ? scalarIn(u8, stu[2][0], 2) : 0;
      const depTs = (stu[3] && typeof stu[3][0] === 'object') ? scalarIn(u8, stu[3][0], 2) : 0;
      const delay = (stu[3] && typeof stu[3][0] === 'object') ? scalarIn(u8, stu[3][0], 1) : 0;

      stops.push({ stopId, arrTs, depTs, delay });
    }

    if (!stops.length) continue;

    const fromGCT = fromId === "1";
    const toGCT   = toId   === "1";

    if (fromGCT) {
      if (stops[0].stopId !== "1") continue;
      if (!stops.some(s => s.stopId === toId)) continue;
    } else if (toGCT) {
      if (stops[stops.length - 1].stopId !== "1") continue;
    } else {
      const fromIdx = stops.findIndex(s => s.stopId === fromId);
      const toIdx   = stops.findIndex(s => s.stopId === toId);
      if (fromIdx === -1 || toIdx === -1) continue;
      if (fromIdx >= toIdx) continue;
    }

    const pcIdx = stops.findIndex(s => s.stopId === fromId);
    if (pcIdx < 0) continue;

    const pc    = stops[pcIdx];
    const depTs = pc.depTs || pc.arrTs;
    if (!depTs || depTs < now - 60) continue;

    const destStop   = stops.find(s => s.stopId === toId);
    const gctArr     = destStop ? (destStop.arrTs || destStop.depTs || null) : null;
    const lvTs       = depTs - (WALK_MINUTES + BUFFER_MINUTES) * 60;
    const delayMins  = Math.round((pc.delay || 0) / 60);
    const stopsCount = (destStop ? stops.indexOf(destStop) : stops.length - 1) - pcIdx;

    trains.push({
      trip_id:          tripId,
      route_id:         routeId,
      dep_ts:           depTs,
      dep_time:         fmtTime(depTs),
      leave_ts:         lvTs,
      leave_time:       fmtTime(lvTs),
      leave_in_seconds: lvTs - now,
      arr_ts:           gctArr,
      arr_time:         gctArr ? fmtTime(gctArr) : null,
      stops_remaining:  stopsCount,
      delay_minutes:    delayMins,
      // Unity-friendly flat fields
      status:           delayMins > 5 ? "DELAYED" : delayMins > 0 ? "LATE" : "ON TIME",
      delay_label:      delayMins > 0 ? `${delayMins} MIN LATE` : "ON TIME",
    });
  }

  trains.sort((a, b) => a.dep_ts - b.dep_ts);
  return trains;
}

function fmtTime(ts) {
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true,
    timeZone: "America/New_York"
  });
}

export default async (req) => {
  try {
    const url    = new URL(req.url);

    // Support lookup by stop ID (numeric) OR station name (string)
    let fromParam = url.searchParams.get("from") || "115";
    let toParam   = url.searchParams.get("to")   || "1";

    // If param is not numeric, treat as station name
    const fromId = /^\d+$/.test(fromParam)
      ? fromParam
      : (STATION_IDS[fromParam.toLowerCase()] || "115");
    const toId = /^\d+$/.test(toParam)
      ? toParam
      : (STATION_IDS[toParam.toLowerCase()] || "1");

    if (!STATIONS[fromId] || !STATIONS[toId]) {
      return new Response(JSON.stringify({
        status: "error",
        message: `Invalid stop. Use numeric ID or exact station name. from="${fromParam}" to="${toParam}"`
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const resp = await fetch(FEED_URL);
    if (!resp.ok) throw new Error(`MTA feed returned ${resp.status}`);
    const trains = parseGtfsRt(await resp.arrayBuffer(), fromId, toId);

    // Full response (website uses this)
    const body = {
      status:         "ok",
      station:        STATIONS[fromId],
      stop_id:        fromId,
      to_station:     STATIONS[toId],
      to_stop_id:     toId,
      walk_minutes:   WALK_MINUTES,
      buffer_minutes: BUFFER_MINUTES,
      trains,
      updated:        new Date().toISOString(),
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({ status: "error", message: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};

export const config = { path: "/api/trains" };
