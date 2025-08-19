// RouteBuilder.tsx — drop into src/components and use on any Astro page with: 
// ---
// import RouteBuilder from "../components/RouteBuilder";
// ---
// <RouteBuilder />  <!-- or <RouteBuilder mode="driving" /> -->
//
// Requirements (install once):
//   npm i mapbox-gl @mapbox/mapbox-gl-geocoder @turf/turf
//   
// Styling (global, e.g., in src/styles/global.css or your layout):
//   import "mapbox-gl/dist/mapbox-gl.css";
//   import "@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css";
//
// Mapbox token: set Vite env VITE_MAPBOX_TOKEN in .env and restart dev server.
//   VITE_MAPBOX_TOKEN=your_real_token_here
//
// This component is self-contained (no Bootstrap/Sass/NavBar/Form dependencies).
// It supports picking Start & End via two geocoder boxes and draws the route.

import "mapbox-gl/dist/mapbox-gl.css";
import "@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css";
import React, { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl, { Map, LngLatLike, Marker } from "mapbox-gl";
import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";
import * as turf from "@turf/turf";

// Ensure token is provided via env; fall back to empty string
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || "";

// Small utility for safe cleanup
const removeIfExists = (map: Map, id: string) => {
  if (!map) return;
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
};

// Allowed profiles match Mapbox Directions profiles
type Profile = "driving" | "walking" | "cycling";

interface Props {
  mode?: Profile; // default "driving"
}

const controlStyles: React.CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  zIndex: 5,
  display: "flex",
  gap: 8,
  alignItems: "center",
  background: "var(--card, rgba(0,0,0,.6))",
  backdropFilter: "blur(6px)",
  border: "1px solid var(--border, rgba(255,255,255,.15))",
  borderRadius: 12,
  padding: "8px 10px",
};

const pillButton: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 999,
  border: "1px solid rgba(255,255,255,.2)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
};

export default function RouteBuilder({ mode = "driving" }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const startMarkerRef = useRef<Marker | null>(null);
  const endMarkerRef = useRef<Marker | null>(null);
  const [profile, setProfile] = useState<Profile>(mode);
  const [start, setStart] = useState<[number, number] | null>(null);
  const [end, setEnd] = useState<[number, number] | null>(null);
  const [distanceKm, setDistanceKm] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canRoute = useMemo(() => !!(start && end), [start, end]);

  // Initialize map
  useEffect(() => {
    if (!containerRef.current) return;
    if (!mapboxgl.accessToken) {
      console.warn("Missing VITE_MAPBOX_TOKEN env var for Mapbox.");
    }

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/streets-v11",
      center: [-84.5, 39.1] as LngLatLike,
      zoom: 12,
      attributionControl: true,
    });

    mapRef.current = map;

    map.on("load", () => {
      map.resize();
      // Try geolocate
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((pos) => {
          const user: [number, number] = [pos.coords.longitude, pos.coords.latitude];
          map.flyTo({ center: user, zoom: 14, speed: 1 });
        });
      }

      // Add geocoder controls (one for Start, one for End)
      const geocoderCommon = {
        accessToken: mapboxgl.accessToken,
        mapboxgl,
        marker: false,
        proximity: undefined as any,
        collapsed: false,
        countries: undefined as any,
        placeholder: "Search...",
        flyTo: false,
      };

      const startGeocoder = new MapboxGeocoder({ ...geocoderCommon, placeholder: "Start location" });
      const endGeocoder = new MapboxGeocoder({ ...geocoderCommon, placeholder: "End location" });

      // Custom containers at top-left
      const startNode = document.createElement("div");
      startNode.className = "rb-geocoder rb-geocoder-start";
      const endNode = document.createElement("div");
      endNode.className = "rb-geocoder rb-geocoder-end";

      map.addControl({
        onAdd: () => {
          startNode.appendChild(startGeocoder.onAdd(map));
          return startNode;
        },
        onRemove: () => {
          startNode.parentNode?.removeChild(startNode);
        },
      } as any, "top-left");

      map.addControl({
        onAdd: () => {
          endNode.appendChild(endGeocoder.onAdd(map));
          return endNode;
        },
        onRemove: () => {
          endNode.parentNode?.removeChild(endNode);
        },
      } as any, "top-left");

      startGeocoder.on("result", (e: any) => {
        const coords = e.result.center as [number, number];
        setError(null);
        setStart(coords);
        // marker
        if (startMarkerRef.current) startMarkerRef.current.remove();
        startMarkerRef.current = new mapboxgl.Marker({ color: "#e63946" }).setLngLat(coords).addTo(map);
      });

      endGeocoder.on("result", (e: any) => {
        const coords = e.result.center as [number, number];
        setError(null);
        setEnd(coords);
        // marker
        if (endMarkerRef.current) endMarkerRef.current.remove();
        endMarkerRef.current = new mapboxgl.Marker({ color: "#457b9d" }).setLngLat(coords).addTo(map);
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
      startMarkerRef.current?.remove();
      endMarkerRef.current?.remove();
    };
  }, []);

  // Fetch and draw route when start/end/profile change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !canRoute) return;

    const fetchRoute = async () => {
      try {
        setLoading(true);
        removeIfExists(map, "route");
        removeIfExists(map, "route-arrows");

        const coords = [start!, end!]
          .map((c) => c.join(","))
          .join(";");

        const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coords}?continue_straight=true&alternatives=false&geometries=geojson&access_token=${mapboxgl.accessToken}`;
        const res = await fetch(url);
        const json = await res.json();
        const route = json?.routes?.[0];
        if (!route) throw new Error("No route returned");

        const line = route.geometry as GeoJSON.LineString;
        const km = route.distance / 1000;
        setDistanceKm(km);

        map.addSource("route", { type: "geojson", data: { type: "Feature", geometry: line } as any });
        map.addLayer({
          id: "route",
          type: "line",
          source: "route",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#3887be", "line-width": 5, "line-opacity": 0.8 },
        });

        // Optional directional arrows using a symbol layer; use built-in triangle icon
        map.addLayer({
          id: "route-arrows",
          type: "symbol",
          source: "route",
          layout: {
            "symbol-placement": "line",
            "symbol-spacing": 100,
            "icon-image": "triangle-11",
            "icon-size": 0.8,
            "icon-rotate": 90,
          },
          paint: {},
        });

        // Fit bounds
        const lineFeature = turf.lineString(line.coordinates);
        const bounds = turf.bbox(lineFeature) as [number, number, number, number];
        map.fitBounds(bounds, { padding: 50, duration: 800 });
      } catch (err: any) {
        console.error(err);
        setError(err?.message || "Failed to get route");
      } finally {
        setLoading(false);
      }
    };

    fetchRoute();
  }, [start, end, profile, canRoute]);

  const clearAll = () => {
    const map = mapRef.current;
    setStart(null);
    setEnd(null);
    setDistanceKm(null);
    setError(null);
    startMarkerRef.current?.remove();
    endMarkerRef.current?.remove();
    startMarkerRef.current = null;
    endMarkerRef.current = null;
    if (map) {
      removeIfExists(map, "route");
      removeIfExists(map, "route-arrows");
    }
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "70vh", borderRadius: 14, overflow: "hidden" }}>
      {/* Top-right controls */}
      <div style={controlStyles}>
        <span style={{ fontSize: 12, opacity: 0.9 }}>Mode</span>
        {["driving", "walking", "cycling"].map((m) => (
          <button
            key={m}
            onClick={() => setProfile(m as Profile)}
            style={{
              ...pillButton,
              background: profile === m ? "rgba(255,255,255,.12)" : "transparent",
              fontWeight: profile === m ? 600 : 400,
            }}
          >
            {m}
          </button>
        ))}
        <button onClick={clearAll} style={{ ...pillButton, marginLeft: 4 }}>Clear</button>
        {distanceKm !== null && (
          <div style={{ marginLeft: 8, fontSize: 12, opacity: 0.9 }}>
            {distanceKm.toFixed(2)} km
          </div>
        )}
        {loading && <div style={{ marginLeft: 6, fontSize: 12 }}>Loading…</div>}
        {error && <div style={{ marginLeft: 6, fontSize: 12, color: "#ffb4b4" }}>{error}</div>}
      </div>

      {/* Map container */}
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      {/* Local styles to stack the two geocoder boxes */}
      <style>{`
        .mapboxgl-ctrl-geocoder { min-width: 280px; }
        .rb-geocoder { margin: 8px; }
        .rb-geocoder-start { margin-bottom: 0; }
        .rb-geocoder-end { margin-top: 8px; }
      `}</style>
    </div>
  );
}
