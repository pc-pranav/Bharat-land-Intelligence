import { useState, useCallback, useMemo } from "react";
import { GoogleMap, useJsApiLoader, MarkerF, InfoWindowF } from "@react-google-maps/api";

// ── Real Google Maps integration — used only in the deployed (Vercel) build ──
// Falls back to the SVG IndiaMap automatically if VITE_GOOGLE_MAPS_API_KEY
// isn't set (see App.jsx — MapView wrapper decides which to render).

const INDIA_CENTER = { lat: 22.5, lng: 79.0 };
const DEFAULT_ZOOM = 5;

const C = {
  navy: "#0F1B2D", bg: "#F8FAFB", green: "#1E6B4A", red: "#C84B31",
  blue: "#2563EB", amber: "#F59E0B", lightBlue: "#EFF6FF",
  border: "#E2E8F0", muted: "#64748B", dark: "#1E293B",
};

function scoreColor(s) {
  return s >= 80 ? C.green : s >= 65 ? C.blue : s >= 50 ? C.amber : C.red;
}

// State centroids (lat/lng), derived from the same boundary data used by the
// SVG map's INDIA_PATHS — used to render colored state-level markers here,
// since Google Maps doesn't have our custom state polygon outlines.
const STATE_CENTROIDS = {
  "Andaman and Nicobar": {lat:11.947, lng:92.941},
  "Andhra Pradesh": {lat:15.992, lng:80.274},
  "Arunachal Pradesh": {lat:27.955, lng:94.878},
  "Assam": {lat:26.064, lng:92.337},
  "Bihar": {lat:26.016, lng:85.874},
  "Chandigarh": {lat:30.733, lng:76.783},
  "Chhattisgarh": {lat:21.089, lng:81.983},
  "Dadra and Nagar Haveli": {lat:20.234, lng:73.075},
  "Daman and Diu": {lat:20.398, lng:72.836},
  "Delhi": {lat:28.706, lng:77.103},
  "Goa": {lat:15.39, lng:74.069},
  "Gujarat": {lat:22.791, lng:70.062},
  "Haryana": {lat:29.231, lng:76.149},
  "Himachal Pradesh": {lat:31.927, lng:77.244},
  "Jammu and Kashmir": {lat:33.984, lng:76.07},
  "Jharkhand": {lat:23.671, lng:85.6},
  "Karnataka": {lat:14.637, lng:75.733},
  "Kerala": {lat:10.74, lng:76.007},
  "Lakshadweep": {lat:10.567, lng:72.642},
  "Madhya Pradesh": {lat:23.541, lng:78.171},
  "Maharashtra": {lat:18.838, lng:75.464},
  "Manipur": {lat:24.738, lng:93.93},
  "Meghalaya": {lat:25.51, lng:91.314},
  "Mizoram": {lat:23.286, lng:92.795},
  "Nagaland": {lat:26.135, lng:94.563},
  "Orissa": {lat:20.602, lng:84.665},
  "Puducherry": {lat:11.917, lng:79.81},
  "Punjab": {lat:30.812, lng:75.487},
  "Rajasthan": {lat:26.794, lng:73.852},
  "Sikkim": {lat:27.534, lng:88.531},
  "Tamil Nadu": {lat:10.227, lng:78.924},
  "Telangana": {lat:18.087, lng:79.265},
  "Tripura": {lat:23.835, lng:91.527},
  "Uttar Pradesh": {lat:27.097, lng:80.583},
  "Uttaranchal": {lat:30.184, lng:79.246},
  "West Bengal": {lat:23.602, lng:87.535},
};

// Map styling to match the app's clean, muted aesthetic instead of default Google colors
const MAP_STYLES = [
  { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "transit", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#E8EEF5" }] },
  { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#F8FAFB" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#FFFFFF" }] },
  { featureType: "administrative", elementType: "labels.text.fill", stylers: [{ color: "#64748B" }] },
];

const mapContainerStyle = { width: "100%", height: "100%" };

// Zoom level past which we switch from state-level circles to city/region
// cluster circles (mirrors the SVG map's zoom>=2.2 threshold, recalibrated
// for Google Maps' zoom scale where ~7 is roughly "looking at one state").
const REGION_ZOOM_THRESHOLD = 7;

export default function GoogleMapView({ pins = [], onStateClick, stateGrowth = {}, regionClusters = {},
  focusLat, focusLng, focusZoom = 11, height = 400 }) {
  const { isLoaded } = useJsApiLoader({
    id: "google-map-script",
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY,
  });

  const [map, setMap] = useState(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [activePin, setActivePin] = useState(null);
  const [activeRegion, setActiveRegion] = useState(null);
  const [mapZoom, setMapZoom] = useState(focusLat && focusLng ? focusZoom : DEFAULT_ZOOM);
  const [nearestState, setNearestState] = useState(null);

  const onLoad = useCallback((m) => setMap(m), []);
  const onUnmount = useCallback(() => setMap(null), []);

  // Track zoom + map center as the user pans/zooms, so we know when to switch
  // from state circles to region-cluster circles, and which state is in view.
  const recalcView = useCallback((m) => {
    if (!m) return;
    const z = m.getZoom();
    setMapZoom(z);
    if (z >= REGION_ZOOM_THRESHOLD) {
      const c = m.getCenter();
      if (!c) return;
      const cLat = c.lat(), cLng = c.lng();
      let nearest = null, minDist = Infinity;
      Object.entries(STATE_CENTROIDS).forEach(([name, pos]) => {
        const d = Math.hypot(pos.lat - cLat, pos.lng - cLng);
        if (d < minDist) { minDist = d; nearest = name; }
      });
      setNearestState(nearest);
    }
  }, []);

  const onIdle = useCallback(() => recalcView(map), [map, recalcView]);

  // Pan/zoom to a focused location when Analyze/Screener supply lat/lng
  const center = useMemo(() => {
    if (focusLat && focusLng) return { lat: focusLat, lng: focusLng };
    return INDIA_CENTER;
  }, [focusLat, focusLng]);

  const zoomLevel = focusLat && focusLng ? focusZoom : DEFAULT_ZOOM;
  const showRegions = mapZoom >= REGION_ZOOM_THRESHOLD && nearestState && regionClusters[nearestState];

  if (!import.meta.env.VITE_GOOGLE_MAPS_API_KEY) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center",
        background: "#FFFBEB", borderRadius: 12, border: "1px solid #FDE68A",
        flexDirection: "column", gap: 8, fontFamily: "Inter,sans-serif", fontSize: 13, color: "#92400E", padding: 20, textAlign: "center" }}>
        <div style={{ fontSize: 24 }}>🗺️</div>
        <div>Google Maps API key not configured.</div>
        <div style={{ fontSize: 11, opacity: 0.8 }}>Add VITE_GOOGLE_MAPS_API_KEY to use the live map. Falling back to built-in map.</div>
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center",
        background: "#F1F5F9", borderRadius: 12, border: "1px solid " + C.border,
        flexDirection: "column", gap: 8, fontFamily: "Inter,sans-serif", fontSize: 13, color: C.muted }}>
        <div style={{ fontSize: 24 }}>🗺️</div>
        <div>Loading Google Maps…</div>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", border: "1px solid " + C.border, height }}>
      <GoogleMap
        mapContainerStyle={mapContainerStyle}
        center={center}
        zoom={zoomLevel}
        onLoad={onLoad}
        onUnmount={onUnmount}
        onIdle={onIdle}
        options={{
          styles: MAP_STYLES,
          disableDefaultUI: false,
          zoomControl: true,
          streetViewControl: true,
          mapTypeControl: true,
          fullscreenControl: false,
        }}
      >
        {/* State-level growth markers — shown until zoomed into a single state.
            This is what was missing before: pins={[]} on the home screen meant
            no color coding appeared at all on the Google Maps layer. */}
        {!showRegions && Object.entries(stateGrowth).map(([name, score]) => {
          const pos = STATE_CENTROIDS[name];
          if (!pos) return null;
          return (
            <MarkerF
              key={"state-"+name}
              position={pos}
              onClick={() => onStateClick && onStateClick(name)}
              label={{ text: String(score), color: "#fff", fontSize: "10px", fontWeight: "700" }}
              icon={{
                path: window.google?.maps?.SymbolPath?.CIRCLE,
                fillColor: scoreColor(score),
                fillOpacity: 0.88,
                strokeColor: "#fff",
                strokeWeight: 1.5,
                scale: 13,
              }}
              title={name + " — " + score + "/100"}
            />
          );
        })}

        {/* Region/city cluster markers — appear once zoomed into a state that
            has curated cluster data (see REGION_CLUSTERS in App.jsx). This is
            the city/area drill-down layer; true district polygon boundaries
            aren't available as open GeoJSON, so named city/area circles are
            the closest accurate equivalent. */}
        {showRegions && regionClusters[nearestState] && regionClusters[nearestState].map((r) => (
          <MarkerF
            key={"region-"+r.name}
            position={{ lat: r.lat, lng: r.lng }}
            onClick={() => { setActiveRegion(r); onStateClick && onStateClick(r.name.split(" (")[0]); }}
            label={{ text: String(r.score), color: "#fff", fontSize: "10px", fontWeight: "700" }}
            icon={{
              path: window.google?.maps?.SymbolPath?.CIRCLE,
              fillColor: scoreColor(r.score),
              fillOpacity: 0.92,
              strokeColor: "#fff",
              strokeWeight: 1.5,
              scale: 11,
            }}
            title={r.name + " — " + r.score + "/100"}
          />
        ))}

        {activeRegion && (
          <InfoWindowF
            position={{ lat: activeRegion.lat, lng: activeRegion.lng }}
            onCloseClick={() => setActiveRegion(null)}
          >
            <div style={{ fontFamily: "Inter,sans-serif", minWidth: 140 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: C.dark, marginBottom: 3 }}>{activeRegion.name}</div>
              <span style={{ background: scoreColor(activeRegion.score), color: "#fff",
                borderRadius: 4, padding: "2px 7px", fontSize: 11, fontWeight: 700 }}>
                Score {activeRegion.score}
              </span>
            </div>
          </InfoWindowF>
        )}

        {pins.map((p, i) => {
          if (!p.lat || !p.lng) return null;
          return (
            <MarkerF
              key={i}
              position={{ lat: p.lat, lng: p.lng }}
              onClick={() => setActivePin(p)}
              label={{
                text: String(p.growth_score || "?"),
                color: "#fff",
                fontSize: "11px",
                fontWeight: "700",
              }}
              icon={{
                path: window.google?.maps?.SymbolPath?.CIRCLE,
                fillColor: scoreColor(p.growth_score || 60),
                fillOpacity: 1,
                strokeColor: "#fff",
                strokeWeight: 2,
                scale: 14,
              }}
            />
          );
        })}

        {activePin && (
          <InfoWindowF
            position={{ lat: activePin.lat, lng: activePin.lng }}
            onCloseClick={() => setActivePin(null)}
          >
            <div style={{ fontFamily: "Inter,sans-serif", minWidth: 160 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: C.dark, marginBottom: 4 }}>
                {activePin.location || activePin.location_name}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                {activePin.growth_score != null && (
                  <span style={{ background: scoreColor(activePin.growth_score), color: "#fff",
                    borderRadius: 4, padding: "2px 7px", fontSize: 11, fontWeight: 700 }}>
                    Score {activePin.growth_score}
                  </span>
                )}
                {activePin.expected_cagr && (
                  <span style={{ background: C.lightBlue, color: C.blue, borderRadius: 4,
                    padding: "2px 7px", fontSize: 11, fontWeight: 600 }}>
                    {activePin.expected_cagr}
                  </span>
                )}
              </div>
              {activePin.current_price_sqft && (
                <div style={{ fontSize: 11, color: C.muted }}>{activePin.current_price_sqft}</div>
              )}
              {activePin.one_line_thesis && (
                <div style={{ fontSize: 10, color: C.muted, fontStyle: "italic", marginTop: 4, lineHeight: 1.4 }}>
                  {activePin.one_line_thesis}
                </div>
              )}
            </div>
          </InfoWindowF>
        )}
      </GoogleMap>

      {/* Legend — collapsed by default, same pattern as the SVG map */}
      <div style={{ position: "absolute", bottom: 8, left: 8, zIndex: 20 }}>
        {legendOpen ? (
          <div onClick={() => setLegendOpen(false)} style={{ cursor: "pointer",
            background: "rgba(255,255,255,0.96)", borderRadius: 7, padding: "5px 9px",
            fontFamily: "Inter,sans-serif", fontSize: 10, display: "flex", flexDirection: "column",
            gap: 3, border: "1px solid " + C.border }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 1 }}>
              <span style={{ fontWeight: 600, color: C.muted, fontSize: 9 }}>LEGEND</span>
              <span style={{ color: C.muted, fontSize: 11 }}>✕</span>
            </div>
            {[{ c: C.green, l: "Mega/Hot Growth (80+)" }, { c: C.blue, l: "Growth Zone (65–79)" },
              { c: C.amber, l: "Stable (50–64)" }, { c: C.red, l: "High Risk (<50)" }].map((x) => (
              <div key={x.l} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: x.c }} />
                <span style={{ color: C.dark }}>{x.l}</span>
              </div>
            ))}
            <div style={{ color: C.muted, fontSize: 8.5, marginTop: 2, fontStyle: "italic" }}>
              {showRegions ? "Showing city/area clusters" : "Zoom in for city-level detail"}
            </div>
          </div>
        ) : (
          <button onClick={() => setLegendOpen(true)} style={{
            background: "rgba(255,255,255,0.96)", border: "1px solid " + C.border, borderRadius: 7,
            padding: "5px 9px", fontFamily: "Inter,sans-serif", fontSize: 10, fontWeight: 600,
            color: C.muted, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.green, display: "inline-block" }} />
            Legend
          </button>
        )}
      </div>
    </div>
  );
}
